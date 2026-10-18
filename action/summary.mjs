#!/usr/bin/env node
// The action's reporting step: find the kept SUMMARY.md, append it to the job summary, set the `verdict` and
// `summary-path` outputs, and on a pull request upsert ONE comment carrying the `<!-- credless -->` marker through
// the REST API with the workflow's own token (no github-script, no dependency). Everything it posts comes from the
// kept evidence folder, which the kit scrubbed and scanned before it was moved out of staging; the script adds only
// links and the exit code. It never reads a key.
//
// Exports are plain functions so `node --test action/` covers them (summary.test.mjs).
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARKER = '<!-- credless -->';

/** GitHub caps an issue comment at 65 536 characters; keep headroom for the header and the footer. */
export const MAX_COMMENT_CHARS = 60_000;

/** The CLI's exit codes, as docs/conventions.md states them. */
export const VERDICT_BY_EXIT_CODE = Object.freeze({ 0: 'pass', 1: 'fail', 2: 'usage', 4: 'unsafe' });

export function verdictFromExitCode(code) {
  const n = Number.parseInt(String(code ?? ''), 10);
  return VERDICT_BY_EXIT_CODE[n] ?? 'unknown';
}

/**
 * The verdict SUMMARY.md states: the kit's heading is `# Run <run id>: PASS|FAIL|UNSAFE`; a `Verdict: pass` line in
 * any common markdown dress is accepted too.
 */
export function verdictFromSummary(summaryMd) {
  const text = summaryMd ?? '';
  const heading = /^#\s*Run\s+\S+:\s*(pass|fail|unsafe)\b/im.exec(text);
  if (heading) return heading[1].toLowerCase();
  const line = /^\s*(?:[*_#>|-]+\s*)*verdict\b[*_:]*\s*[:|]?\s*[*_`]*(pass|fail|unsafe)\b/im.exec(text);
  return line ? line[1].toLowerCase() : null;
}

/** The newest `<reportsDir>/<run id>/SUMMARY.md`, or null. Newest by the folder's mtime, so `--twice` picks the final one. */
export function findLatestSummary(reportsDir) {
  if (!reportsDir || !existsSync(reportsDir)) return null;
  const candidates = readdirSync(reportsDir)
    .map((name) => join(reportsDir, name))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory() && existsSync(join(dir, 'SUMMARY.md'));
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates.length > 0 ? join(candidates[0], 'SUMMARY.md') : null;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  return `${text.slice(0, cut > 0 ? cut : max)}\n\n_(truncated: the full SUMMARY.md is in the artifact)_`;
}

/**
 * The PR comment body. `summaryMd` is the kept SUMMARY.md (already scrubbed and scanned by the kit), or null when
 * none was kept. The marker is the first line, so the next run finds and replaces this comment.
 */
export function commentBody(summaryMd, options = {}) {
  const { exitCode = null, artifactUrl = '', runUrl = '', target = '' } = options;
  const verdict = verdictFromSummary(summaryMd) ?? verdictFromExitCode(exitCode);
  const title = `credless: ${verdict}${target ? ` (${target})` : ''}`;
  const lines = [MARKER, `### ${title}`, ''];
  if (summaryMd) {
    lines.push(truncate(summaryMd.trim(), MAX_COMMENT_CHARS));
  } else if (verdict === 'unsafe') {
    lines.push(
      'The evidence was not safe to keep (something secret-shaped survived the scrub, or post-run did not finish), so the run deleted it. Nothing was uploaded. The job log says which file and which kind of finding; it never prints a value.',
    );
  } else if (verdict === 'usage') {
    lines.push(
      'The run did not start: an unknown or production target, a missing tool or key source, a held lock, or `doctor` refused. See the job log.',
    );
  } else {
    lines.push('No SUMMARY.md was kept for this run. See the job log.');
  }
  lines.push('');
  const footer = [];
  if (exitCode !== null && exitCode !== undefined && exitCode !== '') footer.push(`exit code ${exitCode}`);
  if (artifactUrl) footer.push(`[evidence artifact](${artifactUrl})`);
  if (runUrl) footer.push(`[workflow run](${runUrl})`);
  if (footer.length > 0) lines.push(`_${footer.join(' · ')}_`);
  return `${lines.join('\n')}\n`;
}

async function github(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'credless-action',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  return response;
}

/** Find the comment carrying the marker (first 10 pages of 100) and PATCH it, or POST a new one. */
export async function upsertComment({ apiUrl, repository, token, issueNumber, body }) {
  const base = `${apiUrl}/repos/${repository}/issues/${issueNumber}/comments`;
  let existing = null;
  for (let page = 1; page <= 10 && !existing; page += 1) {
    const response = await github(`${base}?per_page=100&page=${page}`, token);
    if (!response.ok) return { ok: false, status: response.status, step: 'list' };
    const comments = await response.json();
    existing = comments.find((c) => typeof c.body === 'string' && c.body.startsWith(MARKER)) ?? null;
    if (comments.length < 100) break;
  }
  const response = existing
    ? await github(`${apiUrl}/repos/${repository}/issues/comments/${existing.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      })
    : await github(base, token, { method: 'POST', body: JSON.stringify({ body }) });
  return { ok: response.ok, status: response.status, step: existing ? 'update' : 'create' };
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

export async function main(env = process.env) {
  const exitCode = env.EXIT_CODE ?? '';
  const reportsDir = env.REPORTS_DIR || 'reports';
  const summaryPath = env.SUMMARY_PATH || findLatestSummary(reportsDir);
  const summaryMd = summaryPath && existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : null;
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : '';
  const body = commentBody(summaryMd, {
    exitCode,
    artifactUrl: env.ARTIFACT_URL ?? '',
    runUrl,
    target: env.TARGET ?? '',
  });
  const verdict = verdictFromSummary(summaryMd) ?? verdictFromExitCode(exitCode);

  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, body.replace(`${MARKER}\n`, ''));
  setOutput('verdict', verdict);
  setOutput('summary-path', summaryPath ?? '');
  console.log(`credless: verdict ${verdict}${summaryPath ? ` (${summaryPath})` : ' (no SUMMARY.md kept)'}`);

  if (env.GITHUB_EVENT_NAME !== 'pull_request' && env.GITHUB_EVENT_NAME !== 'pull_request_target') return 0;
  if (!env.GITHUB_TOKEN || !env.GITHUB_EVENT_PATH || !env.GITHUB_REPOSITORY) {
    console.log('credless: no token or event; skipping the PR comment');
    return 0;
  }
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const issueNumber = event?.pull_request?.number ?? event?.number;
  if (!issueNumber) {
    console.log('credless: no pull request number in the event; skipping the PR comment');
    return 0;
  }
  const result = await upsertComment({
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    repository: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    issueNumber,
    body,
  });
  if (result.ok) {
    console.log(`credless: PR comment ${result.step}d`);
  } else if (result.status === 403 || result.status === 401) {
    console.log(
      `credless: could not ${result.step} the PR comment (HTTP ${result.status}); the token is read-only here (a fork, or the job lacks pull-requests: write). The job summary has the same content.`,
    );
  } else {
    console.log(
      `credless: could not ${result.step} the PR comment (HTTP ${result.status}); the job summary has the same content.`,
    );
  }
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`credless summary: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(0); // reporting never changes the run's verdict; the final step exits with the CLI's code
    });
}
