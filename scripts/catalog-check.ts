// `node scripts/catalog-check.ts [catalog.yaml] [addressPattern]`: the demo's persona catalog validates and is printed
// as the runner creates it (packages/kit/src/checks/catalog.ts). Plain node, no build. Task 6 wires this into the
// root `catalog:check` script.
import { fileURLToPath } from 'node:url';
import { runCatalogCheck } from '../packages/kit/src/checks/catalog.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const [file = `${root}apps/demo/e2e/personas.yaml`, addressPattern = '^qa\\+[a-z0-9-]+@example\\.com$'] =
  process.argv.slice(2);

process.exit(runCatalogCheck({ file, addressPattern }));
