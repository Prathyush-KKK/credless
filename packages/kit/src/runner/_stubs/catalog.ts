// Stand-in for src/core/catalog.ts (Task 1): read the persona catalog YAML. No schema validation here.
import fs from 'node:fs';
import { parse } from 'yaml';
import type { Catalog } from '../../types.ts';

export function loadCatalog(file: string): Catalog {
  const catalog = parse(fs.readFileSync(file, 'utf8')) as Catalog;
  if (!catalog || typeof catalog !== 'object' || !catalog.personas) throw new Error(`${file} is not a persona catalog`);
  return catalog;
}
