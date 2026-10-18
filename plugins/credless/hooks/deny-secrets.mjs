#!/usr/bin/env node
// credless plugin hook: PreToolUse on Bash. Reads Claude Code's hook input from stdin ({ tool_name, tool_input:
// { command } }), refuses commands that would read the kit's private staging dir, .env files, a process
// environment or memory, a container's configuration, or a secret manager's values, or that expand or set the
// kit's credential variables. A refusal is exit code 2 with a one-line reason on stderr (and the JSON decision on
// stdout for clients that read it); everything else exits 0 and says nothing.
//
// A backstop, not a boundary: an agent with shell access could edit or bypass it. The boundaries are the broker
// process that holds the key and the test API's locks on the server. Plain Node, no dependencies, so it runs the
// same on Linux, macOS and Windows.
//
// Try it: echo '{"tool_name":"Bash","tool_input":{"command":"cat .env"}}' | node hooks/deny-secrets.mjs

import { pathToFileURL } from 'node:url';

const INSTEAD = 'Run `credless doctor` to see what is configured (it prints no value).';
const KEY_VARS = 'CREDLESS_(?:RUNNER_KEY|SIGNIN_PASSWORD)';

// Patterns judged on the whole command text (paths and variable references appear anywhere).
const TEXT_RULES = [
  {
    id: 'staging',
    re: /credless[\\/]staging|\.secret-\d+-(?:key|signin|scrub)|(?:^|[\s'"=:/\\])\.staging(?=$|[\s'"/;|&)])/i,
    why: "that path is the kit's private staging dir: the live run's unscrubbed evidence and the key handover file. Read the kept evidence under reports/<run id>/ after the run.",
  },
  {
    id: 'env-file',
    re: /(?:^|[\s'"=/\\])\.env(?:\.[\w.-]+)?(?=$|[\s'";|&)>])/,
    why: '.env files hold credentials; the runner reads the key from the configured key source itself.',
  },
  {
    id: 'proc',
    re: /\/proc\/[^\s/]+\/(?:environ|mem)\b/,
    why: "that reads a process's environment or memory, where the runner key can be during a run.",
  },
  {
    id: 'credential-file',
    re: /\.kube[\\/]config|\.vault-token|\.config[\\/](?:infisical|doppler|op)[\\/]|\.docker[\\/]config\.json/,
    why: 'that file holds credentials for a secret manager or cluster the runner key comes from.',
  },
  {
    id: 'key-variable',
    re: new RegExp(
      [
        `\\$\\{?${KEY_VARS}`, // $CREDLESS_RUNNER_KEY, ${CREDLESS_RUNNER_KEY_FILE}
        `\\$env:${KEY_VARS}`, // PowerShell
        `%${KEY_VARS}[A-Z_]*%`, // cmd.exe
        `(?:^|[\\s;&|(])(?:export\\s+|set\\s+|setx\\s+)?${KEY_VARS}[A-Z_]*=`, // an assignment on a command line
        `\\bset\\s+${KEY_VARS}`, // cmd.exe `set NAME` prints it
        `(?:process\\.env|os\\.environ|ENV)\\s*(?:\\.|\\[)\\s*['"]?${KEY_VARS}`, // a one-liner in node, python, ruby
        `(?:getenv|GetEnvironmentVariable)\\s*\\(\\s*['"]${KEY_VARS}`,
      ].join('|'),
      'i',
    ),
    why: "that expands, sets or reads the kit's credential variables; they are for the runner's own process only.",
  },
  {
    id: 'env-dump-script',
    re: /console\.log\(\s*process\.env\s*\)|print\(\s*(?:dict\()?os\.environ|GetEnvironmentVariables\s*\(|(?:gci|dir|ls|get-childitem|get-item|gi)\s+env:/i,
    why: 'that prints a whole process environment.',
  },
];

// Rules judged per command segment (after |, ||, &&, ;, &, newlines, subshells): the first word decides.
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'exec', 'nohup', 'time', 'builtin', 'xargs']);
const DEBUGGERS = new Set(['lldb', 'gdb', 'gcore', 'vmmap', 'leaks', 'strace', 'ltrace', 'dtruss']);
const CONTAINERS = new Set(['docker', 'podman', 'nerdctl', 'docker-compose']);

function segments(command) {
  return command
    .split(/\|\||&&|[|;&\n()`]|\$\(/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function words(segment) {
  const out = segment.split(/\s+/);
  // Leading VAR=value assignments and wrappers do not change which command runs.
  while (out.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]) || WRAPPERS.has(out[0]))) out.shift();
  // `env VAR=x cmd` and `env -i cmd` run cmd; a bare `env` is judged below.
  if (out[0] === 'env' && out.slice(1).some((w) => !w.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))) {
    out.shift();
    while (out.length && (out[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]))) out.shift();
  }
  return out;
}

function judgeSegment(segment) {
  const w = words(segment);
  const cmd = (w[0] ?? '').toLowerCase().replace(/^.*[\\/]/, '');
  const rest = w.slice(1);
  const has = (...names) => rest.some((t) => names.includes(t.toLowerCase()));
  if (!cmd) return null;
  if (cmd === 'printenv') return 'that prints the process environment.';
  if (cmd === 'env' && rest.every((t) => /^-[0i]+$|^--null$/.test(t))) return 'that prints the process environment.';
  if ((cmd === 'set' || cmd === 'export') && rest.length === 0) return "that prints the shell's variables.";
  if ((cmd === 'export' || cmd === 'declare' || cmd === 'typeset') && rest.length === 1 && /^-[px]$/.test(rest[0]))
    return "that prints the shell's variables.";
  if (cmd === 'ps' && rest.some((t) => /^-{0,2}[A-Za-z]*[eE][A-Za-z]*$/.test(t)))
    return 'that lists processes with their environment (ps e / -e / -E).';
  if (DEBUGGERS.has(cmd)) return "that attaches to or dumps a process; the broker's memory holds the key during a run.";
  if (CONTAINERS.has(cmd) && (has('inspect', 'exec') || (has('container', 'compose') && has('inspect', 'exec'))))
    return "that reads a container's configuration or opens a shell in it; the run container is the runner's.";
  if (cmd === 'kubectl' && has('get', 'describe') && has('secret', 'secrets'))
    return 'that prints a cluster secret; the runner reads the key through its `key` source itself.';
  if (cmd === 'infisical' && has('secrets', 'export')) return 'that prints values from a secret manager.';
  if (cmd === 'op' && (has('read', 'inject') || (has('item', 'document') && has('get'))))
    return 'that prints values from a secret manager.';
  if (cmd === 'vault' && (has('read') || (has('kv') && has('get')))) return 'that prints values from a secret manager.';
  if (cmd === 'doppler' && has('secrets')) return 'that prints values from a secret manager.';
  if (cmd === 'sops' && has('-d', '--decrypt', 'decrypt')) return 'that decrypts a secrets file.';
  return null;
}

export function judge(command) {
  if (typeof command !== 'string' || command.length === 0) return null;
  for (const rule of TEXT_RULES) if (rule.re.test(command)) return { id: rule.id, why: rule.why };
  for (const segment of segments(command)) {
    const why = judgeSegment(segment);
    if (why) return { id: 'command', why };
  }
  return null;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return 0; // not hook input we understand: a backstop fails open and says so only in verbose output
  }
  const command = input?.tool_input?.command;
  const verdict = judge(command);
  if (!verdict) return 0;
  const reason = `credless hook refused this command: ${verdict.why} ${INSTEAD}`;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    })}\n`,
  );
  process.stderr.write(`${reason}\n`);
  return 2;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
