// Ships the demo in the package from its one source, apps/demo. `pnpm build` runs it after tsdown:
//  1. the server, bundled with what it imports (the kit's test-API server included) into dist/demo/server.js, with
//     the two files it reads at run time beside it (app.html, fake-secrets.json). Node strips no types under
//     node_modules, so the published server must be JavaScript;
//  2. the e2e project into demo/ (gitignored, listed in `files`): the specs, the fixtures, the control class, the
//     persona catalog, both configs and the demo's contract, with the workspace's paths into the kit's source
//     rewritten to the package's own specifiers and the lines between `workspace-only:start` and `workspace-only:end`
//     left out. `credless demo` copies that project out of node_modules before it runs it, because Playwright
//     transforms nothing under node_modules (runner/demo.ts). The TypeScript files ship as `.mts` and the project
//     declares no `"type"`: Node and Playwright treat `.mts` as ES modules in any project, so the demo proves on
//     every run what `init` relies on for a CommonJS project (a `.ts` config there is compiled as CommonJS and fails
//     on `import.meta`);
//  3. the core contract and the backend brief into contract/ (gitignored, listed in `files`), so a backend team can
//     read what to build from the installed package.
// The build fails when a path into the workspace survives a rewrite, so the package can never ship an import that
// only resolves inside this repository.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';
import { KIT_NAME } from '../src/brand.ts';
import { isEntryScript } from '../src/runner/entry.ts';

const KIT = fileURLToPath(new URL('..', import.meta.url));
const DEMO = path.resolve(KIT, '..', '..', 'apps', 'demo');

/** The workspace's paths into the kit, as the demo's e2e files spell them, and what the package's copy says instead. */
export const SPECIFIERS: ReadonlyArray<readonly [string, string]> = [
  ['../../../packages/kit/src/index.ts', KIT_NAME],
  ['../../../packages/kit/src/config/index.ts', `${KIT_NAME}/config`],
  ['../../../packages/kit/src/adapters/index.ts', `${KIT_NAME}/adapters`],
];

/** A marker line, in TypeScript (`//`) or YAML (`#`) comment form. */
const MARKER = /^\s*(?:\/\/|#)\s*workspace-only:(start|end)\s*$/;
/** Three levels up from apps/demo/<dir>/ is the workspace root: nothing in the package may still point there. */
const WORKSPACE_PATH = /\.\.\/\.\.\/\.\.\//;
/** The files of the e2e project and the contract that ship; anything else in those folders stays home. */
const SHIPPED = /\.(?:ts|ya?ml|json)$/;
/** A relative import of a sibling `.ts` file (`'./fixtures.ts'`), which the package's copy spells `.mts`. */
const RELATIVE_TS = /(['"])(\.\.?\/[^'"]+)\.ts\1/g;

/** The name a demo file ships under: TypeScript as `.mts`, everything else unchanged. */
export function shippedName(name: string): string {
  return name.endsWith('.ts') ? `${name.slice(0, -3)}.mts` : name;
}

/** The package's copy of one demo file: the marked blocks dropped, the workspace specifiers rewritten. */
export function packageCopy(source: string, file: string): string {
  const kept: string[] = [];
  let inside = false;
  for (const line of source.split('\n')) {
    const mark = MARKER.exec(line);
    if (mark) {
      if ((mark[1] === 'start') === inside) throw new Error(`${file}: unbalanced workspace-only marker`);
      inside = mark[1] === 'start';
      continue;
    }
    if (!inside) kept.push(line);
  }
  if (inside) throw new Error(`${file}: a workspace-only block has no end marker`);
  let text = kept.join('\n');
  for (const [from, to] of SPECIFIERS) text = text.split(`'${from}'`).join(`'${to}'`);
  text = text.replace(RELATIVE_TS, (_all, quote: string, stem: string) => `${quote}${stem}.mts${quote}`);
  if (WORKSPACE_PATH.test(text)) {
    throw new Error(
      `${file}: a path into the workspace survives in the package's copy; add it to SPECIFIERS or mark it workspace-only`,
    );
  }
  return text;
}

/** Write the e2e project the package ships into `outDir` (replacing what was there); returns the files written. */
export function emitProject(outDir: string = path.join(KIT, 'demo'), demoDir: string = DEMO): string[] {
  fs.rmSync(outDir, { recursive: true, force: true });
  const written: string[] = [];
  for (const sub of ['e2e', 'contract']) {
    fs.mkdirSync(path.join(outDir, sub), { recursive: true });
    for (const name of fs.readdirSync(path.join(demoDir, sub)).sort()) {
      const from = path.join(demoDir, sub, name);
      if (!SHIPPED.test(name) || !fs.statSync(from).isFile()) continue;
      const shipped = shippedName(name);
      fs.writeFileSync(
        path.join(outDir, sub, shipped),
        packageCopy(fs.readFileSync(from, 'utf8'), `apps/demo/${sub}/${name}`),
      );
      written.push(`${sub}/${shipped}`);
    }
  }
  // No "type" on purpose: the .mts files are ES modules on their own, as they are in a user's CommonJS project.
  const manifest = {
    private: true,
    description: `The demo's e2e project as \`${KIT_NAME} demo\` runs it from the package (built from apps/demo).`,
  };
  fs.writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  written.push('package.json');
  return written;
}

/** Bundle the demo server into dist/demo/server.js and copy the files it reads beside it. */
export async function bundleServer(outDir: string = path.join(KIT, 'dist', 'demo')): Promise<void> {
  await build({
    config: false,
    cwd: KIT,
    entry: { server: path.join(DEMO, 'src', 'server.ts') },
    outDir,
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
    sourcemap: false,
    logLevel: 'warn',
  });
  // read with fs at run time, beside the script (server.ts: app.html; runner/demo.ts: the stand-in password)
  for (const name of ['app.html', 'fake-secrets.json']) {
    fs.copyFileSync(path.join(DEMO, 'src', name), path.join(outDir, name));
  }
  const emitted = fs.readdirSync(outDir).sort();
  const expected = ['app.html', 'fake-secrets.json', 'server.js'];
  if (emitted.join() !== expected.join()) {
    throw new Error(`dist/demo holds ${emitted.join(', ')}; expected ${expected.join(', ')} (a split chunk?)`);
  }
}

/** Copy the workspace's contract/ (the core OpenAPI contract and the backend brief) into the package. */
export function copyContract(outDir: string = path.join(KIT, 'contract')): string[] {
  const from = path.resolve(KIT, '..', '..', 'contract');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const names = fs
    .readdirSync(from)
    .filter((n) => /\.(?:ya?ml|md)$/.test(n))
    .sort();
  for (const name of names) fs.copyFileSync(path.join(from, name), path.join(outDir, name));
  if (!names.includes('core.openapi.yaml')) throw new Error('contract/core.openapi.yaml is missing from the workspace');
  return names;
}

if (isEntryScript(import.meta.url)) {
  await bundleServer();
  const files = emitProject();
  const contract = copyContract();
  console.log(
    `build-demo: dist/demo/ (server.js, app.html, fake-secrets.json), demo/ (${files.length} files), contract/ (${contract.join(', ')})`,
  );
}
