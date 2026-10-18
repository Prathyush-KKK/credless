// The kit's name, in the one place code reads it from. A rename is: the constants below, `name` and the `bin` key in
// packages/kit/package.json, and the `credless` dependency key in apps/demo/package.json. Nothing else in the code
// spells the name: env var names, the canary host, staging paths and messages all derive from here.

/** The npm package name and the word the docs use for the kit. */
export const KIT_NAME = 'credless' as const;

/** The prefix of every environment variable the kit reads or sets (`CREDLESS_TARGET`, `CREDLESS_RUN_ID`, ...). */
export const ENV_PREFIX = 'CREDLESS_' as const;

/** The command the `bin` entry installs (`npx credless run --target dev`). */
export const CLI_NAME = 'credless' as const;

/** Where the docs are: messages that point at the backend brief or a doc page link under it. */
export const REPO_URL = 'https://github.com/Prathyush-KKK/credless' as const;

/**
 * The host the canary request goes to after every persona context is created. It is under the reserved `.invalid`
 * TLD, so it can never resolve: the context's own egress proxy answers it with 204 and records the context id, which
 * proves THIS context's traffic goes through THIS proxy (plan §6 T1, T5).
 */
export const CANARY_HOST = `canary.${KIT_NAME}.invalid` as const;
