// The judge stage: score the answers a run recorded (fixtures/judge.ts) and write `judge/results.json` and JUDGE.md
// into the run folder. `run` calls it on the host after the suite and before post-run, so what it writes is scrubbed
// and scanned with the rest; `credless judge <run>` calls it again on a kept run, for verdicts a judge agent wrote.
//
// Who scores, per case with a rubric:
//  - a verdict file already in `judge/verdicts/<case id>.json`: used as it is (how a judge agent hands its scores in);
//  - else the judge command, when there is one: a JSON argv (`["claude","-p"]`) that reads the prompt on stdin and
//    prints one JSON verdict. It runs with this machine's environment minus every `CREDLESS_*` name, so it never
//    sees the run's key file, broker token or evidence key; it is sent the question, the answer and the facts only;
//  - else nobody: the case is listed `unjudged`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV_PREFIX, KIT_NAME } from '../brand.ts';
import {
  countStatuses,
  JUDGE,
  type JudgeCase,
  type JudgeResults,
  judgedOk,
  judgeLine,
  judgePrompt,
  parseVerdict,
  type Settled,
  settle,
  type Verdict,
} from './judge.ts';

/** How long one answer may take the judge command. */
export const JUDGE_TIMEOUT_MS = 120_000;

/** The biggest verdict read from a judge command's output; anything past it is cut. */
const MAX_OUTPUT = 1024 * 1024;

export interface JudgeStageOptions {
  /** the run folder (staging while the run lasts, or a kept report) */
  runDir: string;
  /** the judge command as an argv, or null for none */
  command: readonly string[] | null;
  /** unsure and unjudged answers fail the run too */
  gate?: boolean;
  /** the environment the command gets, before the `CREDLESS_*` names are dropped; default process.env */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  log?: (line: string) => void;
}

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

/** The cases a run recorded, in a stable order. */
export function readCases(runDir: string): JudgeCase[] {
  const dir = path.join(runDir, JUDGE.cases);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJson<JudgeCase>(path.join(dir, f)))
    .filter((c): c is JudgeCase => Boolean(c?.id));
}

/** This environment without any of the kit's own names: what a judge command may see. */
export function judgeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !name.toUpperCase().startsWith(ENV_PREFIX)) out[name] = value;
  }
  return out;
}

/** Run the command once with the prompt on stdin; its stdout, or the reason it gave none. */
function ask(
  command: readonly string[],
  prompt: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ output: string } | { problem: string }> {
  return new Promise((resolve) => {
    const [file, ...args] = command;
    if (!file) {
      resolve({ problem: 'the judge command is empty' });
      return;
    }
    let output = '';
    let settled = false;
    const done = (r: { output: string } | { problem: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ problem: `the judge command gave no answer within ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8');
    });
    child.on('error', (error) => done({ problem: `the judge command could not start: ${error.message}` }));
    child.on('close', (code) => {
      if (code === 0) done({ output });
      else done({ problem: `the judge command exited ${code}` });
    });
    child.stdin.on('error', () => undefined); // a command that exits without reading its input
    child.stdin.end(prompt);
  });
}

/** Score what needs scoring, settle every case, and write `judge/results.json` and JUDGE.md. */
export async function judgeStage(options: JudgeStageOptions): Promise<JudgeResults | null> {
  const cases = readCases(options.runDir);
  if (!cases.length) return null;
  const log = options.log ?? (() => undefined);
  const gate = Boolean(options.gate);
  const verdictsDir = path.join(options.runDir, JUDGE.verdicts);
  const env = judgeEnvironment(options.env ?? process.env);
  let judgedBy: JudgeResults['judgedBy'] = 'none';
  let commandProblem: string | undefined;
  const settled: Settled[] = [];

  for (const c of cases) {
    const file = path.join(verdictsDir, `${c.id}.json`);
    let verdict = readJson<Verdict>(file);
    if (verdict) judgedBy = judgedBy === 'command' ? 'command' : 'files';
    const needsJudge = c.rubric.length > 0 && !verdict;
    if (needsJudge && options.command && !commandProblem) {
      const answer = await ask(options.command, judgePrompt(c), env, options.timeoutMs ?? JUDGE_TIMEOUT_MS);
      if ('problem' in answer) {
        commandProblem = answer.problem;
        log(`judge: ${answer.problem}; the remaining answers stay unjudged`);
      } else {
        verdict = parseVerdict(c.id, answer.output);
        if (verdict) {
          fs.mkdirSync(verdictsDir, { recursive: true });
          fs.writeFileSync(file, `${JSON.stringify({ ...verdict, by: 'command' }, null, 2)}\n`);
          judgedBy = 'command';
        }
      }
    }
    const s = settle(c, verdict);
    if (needsJudge && options.command && !verdict && !commandProblem && s.status === 'unjudged') {
      s.status = 'unsure';
      s.problems = ['the judge command printed no verdict (one JSON object with a "scores" array)'];
    }
    settled.push(s);
  }

  const counts = countStatuses(settled);
  const results: JudgeResults = { judgedBy, gate, counts, ok: judgedOk(settled, gate), cases: settled };
  if (commandProblem) results.commandProblem = commandProblem;
  fs.mkdirSync(path.join(options.runDir, JUDGE.dir), { recursive: true });
  fs.writeFileSync(path.join(options.runDir, JUDGE.results), `${JSON.stringify(results, null, 2)}\n`);
  fs.writeFileSync(path.join(options.runDir, JUDGE.report), renderJudgeReport(results, cases));
  return results;
}

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');

/** JUDGE.md: every answer, its outcome, and the judge's quoted evidence. */
export function renderJudgeReport(results: JudgeResults, cases: readonly JudgeCase[]): string {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const lines = [
    '# Answers a model wrote',
    '',
    `${judgeLine(results)}. Judged by: ${results.judgedBy === 'none' ? 'nobody yet' : results.judgedBy === 'files' ? 'verdict files' : 'the judge command'}.`,
    results.commandProblem ? `The judge command failed: ${results.commandProblem}.` : null,
    'Markers are checked in the test; a rubric score counts only when its quote is in the answer word for word.',
    '',
    '| Answer | Test | Project | Outcome | Score | Why |',
    '|---|---|---|---|---|---|',
    ...results.cases.map(
      (s) =>
        `| ${esc(s.id)} | ${esc(s.test)} | ${esc(s.project)} | ${s.status} | ${s.score === null ? '' : s.score.toFixed(2)} | ${esc(s.problems.join('; '))} |`,
    ),
    '',
  ];
  for (const s of results.cases) {
    const c = byId.get(s.id);
    if (!c) continue;
    lines.push(`## ${s.id}`, '', `Question: ${esc(c.question)}`, '', `Answer: ${esc(c.answer)}`, '');
    if (c.facts.length) lines.push('Facts:', ...c.facts.map((f) => `- ${esc(f)}`), '');
  }
  if (results.counts.unjudged) {
    lines.push(
      '## Judging what is unjudged',
      '',
      `Write \`${JUDGE.verdicts}/<answer>.json\` (\`{"id": "<answer>", "scores": [{"criterion", "score", "quote", "why"}]}\`)`,
      `for each one, from \`${JUDGE.cases}/<answer>.json\`, then run \`${KIT_NAME} judge <run id>\`; or pass a judge command`,
      `(\`${KIT_NAME} judge <run id> --judge '["claude","-p"]'\`).`,
      '',
    );
  }
  return `${lines.filter((l) => l !== null).join('\n')}\n`;
}

// --- which command judges ----------------------------------------------------------------------------------------

/** `$XDG_CONFIG_HOME/<kit>/judge` or `~/.config/<kit>/judge`; `%APPDATA%\<kit>\judge` on Windows. */
export function judgeFilePath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), KIT_NAME, 'judge');
  }
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, KIT_NAME, 'judge');
}

/** A judge command written as a JSON array of strings, or the reason it is not one. */
export function parseJudgeCommand(text: string): { command: string[] } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: `a judge command is a JSON array of strings, like '["claude","-p"]' (got ${text.slice(0, 60)})` };
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string' && v.length > 0)) {
    return { error: 'a judge command is a non-empty JSON array of non-empty strings' };
  }
  return { command: value as string[] };
}

export interface JudgeCommandChoice {
  command: string[] | null;
  /** where it came from, for messages: `--judge`, the file path, `--no-judge` or `none` */
  source: string;
}

/** `--no-judge`, else `--judge <json>`, else this machine's judge file, else none. */
export function resolveJudgeCommand(options: {
  flag?: string;
  off?: boolean;
  env?: NodeJS.ProcessEnv;
  file?: string;
}): JudgeCommandChoice | { error: string } {
  if (options.off) return { command: null, source: '--no-judge' };
  if (options.flag !== undefined) {
    const parsed = parseJudgeCommand(options.flag);
    return 'error' in parsed ? { error: `--judge: ${parsed.error}` } : { command: parsed.command, source: '--judge' };
  }
  const file = options.file ?? judgeFilePath(options.env);
  if (!fs.existsSync(file)) return { command: null, source: 'none' };
  const parsed = parseJudgeCommand(fs.readFileSync(file, 'utf8').trim());
  return 'error' in parsed ? { error: `${file}: ${parsed.error}` } : { command: parsed.command, source: file };
}
