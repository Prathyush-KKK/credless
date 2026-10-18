// `check:catalog`: a persona catalog validates (core/catalog.ts: the schema plus the rules a schema cannot express,
// unique first names and addresses inside the configured range), and prints the catalog as the runner will create
// it in namespace a0. No secrets are involved: a catalog holds none, and the schema refuses credential-shaped keys.
import { loadCatalog, personasIn, resolveAddress } from '../core/catalog.ts';
import type { Catalog, Persona } from '../types.ts';

export interface CatalogCheckInput {
  /** the catalog file (`personas.catalog` in the config) */
  file: string;
  /** `personas.addressPattern`: every rendered address must match it */
  addressPattern: string;
  /** the namespace the listing renders; default `a0` */
  ns?: string;
}

export interface CatalogCheckResult {
  catalog: Catalog;
  personas: Persona[];
  addresses: Array<{ name: string; address: string; purpose: string }>;
  /** the listing, one line per persona and address */
  listing: string;
}

/** Validate a catalog and render its listing. Throws with every problem listed when the catalog is invalid. */
export function checkCatalog(input: CatalogCheckInput): CatalogCheckResult {
  const ns = input.ns ?? 'a0';
  const catalog = loadCatalog(input.file, { addressPattern: input.addressPattern });
  const personas = personasIn(ns, catalog, { addressPattern: input.addressPattern });
  const addresses = Object.entries(catalog.addresses ?? {}).map(([name, a]) => ({
    name,
    address: resolveAddress(name, ns, catalog),
    purpose: a.purpose,
  }));
  const rows = personas.map((p) => `  ${p.id.padEnd(14)} ${p.role.padEnd(8)} ${p.auth.padEnd(9)} ${p.email}`);
  const addressRows = addresses.map((a) => `  address ${a.name}: ${a.address}`);
  const listing = [
    `persona catalog (${catalog.status ?? 'draft'}): ${personas.length} personas, ${addresses.length} addresses`,
    `  ${'id'.padEnd(14)} ${'role'.padEnd(8)} ${'auth'.padEnd(9)} address in namespace ${ns}`,
    ...rows,
    ...addressRows,
  ].join('\n');
  return { catalog, personas, addresses, listing };
}

/** The check as a command: prints the listing or the problems and returns the exit code. */
export function runCatalogCheck(input: CatalogCheckInput): number {
  try {
    console.log(checkCatalog(input).listing);
    return 0;
  } catch (error) {
    console.error(`catalog check FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
