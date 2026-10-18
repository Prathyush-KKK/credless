// The config file's schema (plan §4.1): zod 4 validates `<kit>.config.ts` once, `defineConfig` returns it with
// defaults filled in. Every host rule is a string, so the result is serialisable to workers and to the doctor.
import { z } from 'zod';
import { type AppSignals, DEFAULTS, ENV, type KitConfig, PATTERNS, type Target } from '../types.ts';
import { assertNoProductionOverlap } from './load.ts';

const httpOrigin = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
    } catch {
      return false;
    }
  },
  { message: 'must be an http(s) URL without credentials' },
);

const regexSource = z.string().refine(
  (value) => {
    try {
      new RegExp(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be a valid regular expression source' },
);

/** An exact hostname or a glob with a leading `*.` label; lowercase; no port, scheme or path. */
const hostGlob = z.string().regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, {
  message: 'a host rule is a hostname or a *.label.tld glob',
});

const headerName = z.string().regex(/^[A-Za-z0-9-]+$/, { message: 'a header name is letters, digits and hyphens' });

const target = z.strictObject({
  web: httpOrigin,
  api: httpOrigin,
  testApi: httpOrigin.optional(),
  kind: z.enum(['local', 'remote']).optional(),
});

const keySource = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('env'),
    name: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
  }),
  z.strictObject({ source: z.literal('file'), path: z.string().min(1) }),
  z
    .strictObject({
      source: z.literal('exec'),
      argv: z.array(z.string()).min(1).optional(),
      preset: z.enum(['op', 'infisical', 'doppler', 'vault', 'kubectl']).optional(),
      ref: z.string().min(1).optional(),
    })
    .refine((v) => (v.argv ? !v.preset && !v.ref : Boolean(v.preset && v.ref)), {
      message: 'an exec key source takes either argv, or a preset with its ref',
    }),
  z.strictObject({ source: z.literal('keyring'), service: z.string().min(1), account: z.string().min(1) }),
]);

const sessionProvider = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('test-api') }),
  z.strictObject({ provider: z.literal('storage-state-file'), dir: z.string().min(1) }),
  z.strictObject({ provider: z.literal('module'), module: z.string().min(1) }),
]);

const mailSink = z.discriminatedUnion('sink', [
  z.strictObject({ sink: z.literal('test-api') }),
  z.strictObject({ sink: z.literal('mailpit'), url: httpOrigin }),
  z.strictObject({ sink: z.literal('module'), module: z.string().min(1) }),
]);

const fn = <F>() => z.custom<F>((value) => typeof value === 'function', { message: 'must be a function' });

const signals = z.strictObject({
  sessionCookies: z.array(z.string().min(1)).optional(),
  unexpectedSignOut: fn<AppSignals['unexpectedSignOut']>().optional(),
  apiError: fn<AppSignals['apiError']>().optional(),
  csrf: z.strictObject({ cookie: z.string().min(1), header: headerName }).optional(),
  bootCover: z.string().min(1).optional(),
});

/** The schema of {@link KitConfig}. Unknown keys are errors, so a typo never silently disables a lock. */
export const kitConfigSchema = z.strictObject({
  targets: z
    .record(
      z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, { message: 'a target name is lowercase letters, digits and hyphens' }),
      target,
    )
    .refine((targets) => Object.keys(targets).length > 0, { message: 'at least one target' }),
  production: z.strictObject({
    domains: z.array(
      hostGlob.refine((d) => !d.startsWith('*.'), { message: 'a production domain is a bare domain, not a glob' }),
    ),
    words: z
      .array(z.string().regex(/^[a-z0-9]+$/, { message: 'a production word is lowercase letters and digits' }))
      .optional(),
    nonProductionPattern: regexSource.optional(),
  }),
  hosts: z
    .strictObject({
      thirdParty: z.array(hostGlob).optional(),
      analytics: z.array(hostGlob).optional(),
      outside: z.enum(['fail', 'note']).optional(),
    })
    .optional(),
  personas: z.strictObject({
    catalog: z.string().min(1),
    addressPattern: regexSource,
    slot: z.string().regex(PATTERNS.slot, { message: 'a slot is one lowercase letter' }).optional(),
    workers: z.int().min(1).max(100).optional(),
  }),
  testApi: z
    .strictObject({
      basePath: z
        .string()
        .regex(/^\/[A-Za-z0-9_./-]*[A-Za-z0-9_-]$/, { message: 'a base path starts with / and has no trailing slash' })
        .optional(),
      keyHeader: headerName.optional(),
      contract: z.string().min(1).optional(),
      headers: z.record(headerName, z.string()).optional(),
    })
    .optional(),
  key: keySource,
  session: sessionProvider.optional(),
  control: z.strictObject({ module: z.string().min(1) }).optional(),
  mail: mailSink.optional(),
  signals: signals.optional(),
  evidence: z
    .strictObject({
      reportsDir: z.string().min(1).optional(),
      stagingDir: z.string().min(1).optional(),
      bootCover: z.string().min(1).optional(),
      maskSelectors: z.array(z.string().min(1)).optional(),
      codeShape: z.union([z.literal('digits6'), regexSource]).optional(),
      trace: z.enum(['off', 'retain-on-failure', 'on']).optional(),
      retainOnPass: z.boolean().optional(),
    })
    .optional(),
  browsers: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        use: z.record(z.string(), z.unknown()),
        metadata: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
  docker: z.strictObject({ image: z.string().min(1).optional(), isolate: z.boolean().optional() }).optional(),
});

/** One line per problem, with its path, for a person fixing the config. */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`).join('\n');
}

function withDefaults(config: KitConfig): KitConfig {
  const targets: Record<string, Target> = {};
  for (const [name, t] of Object.entries(config.targets)) {
    targets[name] = { web: t.web, api: t.api, testApi: t.testApi ?? t.api, kind: t.kind ?? 'remote' };
  }
  return {
    ...config,
    targets,
    production: { ...config.production, words: config.production.words ?? [...DEFAULTS.productionWords] },
    hosts: { thirdParty: [], analytics: [], ...config.hosts, outside: config.hosts?.outside ?? DEFAULTS.outside },
    personas: {
      ...config.personas,
      slot: config.personas.slot ?? DEFAULTS.slot,
      workers: config.personas.workers ?? DEFAULTS.workers,
    },
    testApi: {
      ...config.testApi,
      basePath: config.testApi?.basePath ?? DEFAULTS.basePath,
      keyHeader: config.testApi?.keyHeader ?? DEFAULTS.keyHeader,
      headers: config.testApi?.headers ?? {},
    },
    key: config.key.source === 'env' ? { source: 'env', name: config.key.name ?? ENV.RUNNER_KEY } : config.key,
    session: config.session ?? { provider: 'test-api' },
    mail: config.mail ?? { sink: 'test-api' },
    evidence: {
      ...config.evidence,
      reportsDir: config.evidence?.reportsDir ?? DEFAULTS.reportsDir,
      codeShape: config.evidence?.codeShape ?? DEFAULTS.codeShape,
      trace: config.evidence?.trace ?? DEFAULTS.trace,
      retainOnPass: config.evidence?.retainOnPass ?? false,
    },
  };
}

/**
 * Validate a config and return it with defaults filled in. The only export a `<kit>.config.ts` needs. Throws with
 * every problem listed, and refuses a config whose target hosts or host rules could be production.
 */
export function defineConfig(config: KitConfig): KitConfig {
  const parsed = kitConfigSchema.safeParse(config);
  if (!parsed.success) throw new Error(`the config is invalid:\n${describeIssues(parsed.error)}`);
  // the parsed copy is validated; the original keeps function identity for signals and any class instances
  const normalised = withDefaults(config);
  assertNoProductionOverlap(normalised);
  return normalised;
}
