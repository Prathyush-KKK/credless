// The plugin's PreToolUse hook (plugins/credless/hooks/deny-secrets.mjs): refuses the listed commands with exit 2 and
// a one-line reason, lets everything else through with exit 0 and no output. Spawned as Claude Code spawns it: the
// hook input as JSON on stdin.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const hook = path.resolve(here, '../../../../plugins/credless/hooks/deny-secrets.mjs');

function run(input: unknown) {
  const result = spawnSync(process.execPath, [hook], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

const denied: Array<[string, string]> = [
  ['the staging dir', 'ls ~/.cache/credless/staging'],
  ['a key handover file', 'cat ~/.cache/credless/staging/.secret-4242-key'],
  ['the Windows staging dir', 'type %LOCALAPPDATA%\\credless\\staging\\run.json'],
  ['a repo-local staging dir', 'ls .staging/'],
  ['.env', 'cat .env'],
  ['.env.local', 'cat .env.local'],
  ['a nested .env', 'cat ./config/.env'],
  ['.env in a pipeline', 'ls && cat .env | head'],
  ['/proc/<pid>/environ', 'cat /proc/1234/environ'],
  ['/proc/self/environ', 'tr "\\0" "\\n" < /proc/self/environ'],
  ['/proc/<pid>/mem', 'strings /proc/42/mem'],
  ['printenv', 'printenv'],
  ['printenv with a name', 'printenv CREDLESS_TARGET'],
  ['env alone', 'env'],
  ['env piped', 'env | grep KEY'],
  ['env -0', 'env -0'],
  ['sudo env', 'sudo env'],
  ['env printenv', 'env printenv'],
  ['set alone', 'set'],
  ['export alone', 'export'],
  ['declare -x', 'declare -x'],
  ['ps e', 'ps e'],
  ['ps -e', 'ps -e'],
  ['ps eww', 'ps eww'],
  ['ps -ef', 'ps -ef'],
  ['ps axe', 'ps axe | grep node'],
  ['docker inspect', 'docker inspect abc123'],
  ['docker container inspect', 'docker container inspect abc123'],
  ['docker exec', 'docker exec -it abc123 sh'],
  ['docker compose exec', 'docker compose exec app sh'],
  ['podman exec', 'podman exec -it abc123 sh'],
  ['lldb', 'lldb -p 4242'],
  ['gdb', 'gdb -p 4242'],
  ['gcore', 'gcore 4242'],
  ['kubectl get secret', 'kubectl get secret runner-key -o yaml'],
  ['kubectl -n get secrets', 'kubectl -n dev get secrets'],
  ['kubectl describe secret', 'kubectl describe secret runner-key'],
  ['infisical secrets get', 'infisical secrets get CREDLESS_RUNNER_KEY --plain'],
  ['infisical export', 'infisical export'],
  ['op read', 'op read op://vault/item/field'],
  ['op item get', 'op item get "runner key"'],
  ['vault kv get', 'vault kv get secret/credless'],
  ['vault read', 'vault read secret/credless'],
  ['doppler secrets', 'doppler secrets download --no-file'],
  ['sops -d', 'sops -d secrets.yaml'],
  ['$CREDLESS_RUNNER_KEY', 'echo $CREDLESS_RUNNER_KEY'],
  ['a braced expansion of the password variable', `echo "\${CREDLESS_SIGNIN_PASSWORD}"`],
  ['the key file variable', 'cat $CREDLESS_RUNNER_KEY_FILE'],
  ['export CREDLESS_RUNNER_KEY=', 'export CREDLESS_RUNNER_KEY=abc'],
  ['an inline assignment', 'CREDLESS_RUNNER_KEY=abc credless run --target staging'],
  ['PowerShell $env:', 'echo $env:CREDLESS_RUNNER_KEY'],
  ['cmd.exe %VAR%', 'echo %CREDLESS_RUNNER_KEY%'],
  ['cmd.exe set NAME', 'set CREDLESS_RUNNER_KEY'],
  ['node process.env', 'node -e "console.log(process.env.CREDLESS_RUNNER_KEY)"'],
  ['python os.environ', 'python3 -c "import os; print(os.environ[\'CREDLESS_RUNNER_KEY\'])"'],
  ['a whole env dump in node', 'node -e "console.log(process.env)"'],
  ['Get-ChildItem Env:', 'Get-ChildItem Env:'],
  ['kube config', 'cat ~/.kube/config'],
  ['vault token', 'cat ~/.vault-token'],
];

const allowed: Array<[string, string]> = [
  ['ls', 'ls'],
  ['npm test', 'npm test'],
  ['credless doctor', 'credless doctor --target staging'],
  ['credless run', 'npx credless run --target staging -g W3'],
  ['echo environment', 'echo environment'],
  ['npm run env:check', 'npm run env:check'],
  ['a word containing env', 'grep -rn environment src/'],
  ['.envrc is not .env', 'cat .envrc'],
  ['the variable name as a search term', 'grep -rn CREDLESS_RUNNER_KEY e2e/ src/'],
  ['the TARGET variable', 'echo $CREDLESS_TARGET'],
  ['CREDLESS_SLOT assignment', 'CREDLESS_SLOT=b npx credless run --target staging'],
  ['ps aux', 'ps aux | grep node'],
  ['set -euo pipefail', 'set -euo pipefail; npm test'],
  ['export NAME=value', 'export NODE_ENV=test'],
  ['env VAR=value cmd', 'env NODE_ENV=test npm test'],
  ['env -i cmd', 'env -i PATH=/usr/bin node --version'],
  ['docker ps', 'docker ps'],
  ['docker compose up', 'docker compose up -d'],
  ['kubectl get pods', 'kubectl get pods -n dev'],
  ['op --version', 'op --version'],
  ['vault status', 'vault status'],
  ['git status', 'git status'],
  ['reading kept evidence', 'cat reports/20261008T101500Z-ab12/SUMMARY.md'],
  ['a node one-liner on another variable', 'node -e "console.log(process.env.CREDLESS_TARGET)"'],
  ['opening a trace', 'npx playwright show-trace reports/20261008T101500Z-ab12/artifacts/w3/trace.zip'],
];

describe('deny-secrets hook', () => {
  it.each(denied)('denies %s', (_label, command) => {
    const { code, stdout, stderr } = run(bash(command));
    expect(code, `expected a refusal of: ${command}\nstdout: ${stdout}\nstderr: ${stderr}`).toBe(2);
    expect(stderr.trim().split('\n')).toHaveLength(1);
    expect(stderr).toContain('credless hook refused');
    expect(stderr).toContain('credless doctor');
    const decision = JSON.parse(stdout) as {
      hookSpecificOutput: { permissionDecision: string; hookEventName: string };
    };
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  });

  it.each(allowed)('allows %s', (_label, command) => {
    const { code, stdout, stderr } = run(bash(command));
    expect(code, `expected to allow: ${command}\nstderr: ${stderr}`).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });

  it('never prints the command it refused', () => {
    const { stderr, stdout } = run(bash('cat .env.production.local'));
    expect(stderr).not.toContain('.env.production.local');
    expect(stdout).not.toContain('.env.production.local');
  });

  it('ignores other tools and malformed input', () => {
    expect(run({ tool_name: 'Read', tool_input: { file_path: '.env' } }).code).toBe(0);
    expect(run({ tool_name: 'Bash', tool_input: {} }).code).toBe(0);
    expect(run('not json').code).toBe(0);
    expect(run('').code).toBe(0);
  });
});
