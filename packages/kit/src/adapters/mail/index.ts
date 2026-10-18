// Mail sinks (plan §4.2): where a persona's mail is read from. Mail to test accounts is captured, never sent.
import type { MailSink, MailSinkRef } from '../../types.ts';
import { extractFromBody, type MailpitOptions, mailpitMailSink } from './mailpit.ts';
import { messageMatches, pollForMessage, type TestApiMailOptions, testApiMailSink, toMessage } from './test-api.ts';

export type { MailpitOptions, TestApiMailOptions };
export { extractFromBody, mailpitMailSink, messageMatches, pollForMessage, testApiMailSink, toMessage };

export interface MailSinkDeps {
  /** what the `test-api` sink needs: the client and the address-to-handle map of the worker's namespace */
  testApi?: TestApiMailOptions;
  /** what the `mailpit` sink takes besides its URL */
  mailpit?: Omit<MailpitOptions, 'url'>;
}

/** The built-in mail sink for a config reference (`test-api`, `mailpit`); `module` needs {@link loadMailSink}. */
export function mailSink(ref: MailSinkRef, deps: MailSinkDeps = {}): MailSink {
  switch (ref.sink) {
    case 'test-api':
      if (!deps.testApi) throw new Error('the test-api mail sink needs { api, handleFor }');
      return testApiMailSink(deps.testApi);
    case 'mailpit':
      return mailpitMailSink({ url: ref.url, ...deps.mailpit });
    case 'module':
      throw new Error(`mail sink module ${ref.module} must be loaded with loadMailSink()`);
    default:
      throw new Error(`unknown mail sink ${String((ref as { sink?: unknown }).sink)}`);
  }
}

/** Like {@link mailSink}, and loads a `module` reference (default export: a MailSink). */
export async function loadMailSink(ref: MailSinkRef, deps: MailSinkDeps = {}): Promise<MailSink> {
  if (ref.sink !== 'module') return mailSink(ref, deps);
  const loaded = (await import(ref.module)) as { default?: unknown };
  const sink = loaded.default as MailSink | undefined;
  if (!sink || typeof sink.messages !== 'function' || typeof sink.waitFor !== 'function')
    throw new Error(`${ref.module} does not export a MailSink as default`);
  return sink;
}

/** The stub's name for {@link mailSink}. */
export const createMailSink = mailSink;
