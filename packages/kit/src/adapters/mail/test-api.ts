// The default mail sink: what the backend captured for a test account, through `GET /personas/{handle}/messages`.
// Codes are wrapped as Secrets here, before any test sees them.
import { Secret } from '../../core/secret.ts';
import type {
  MailMatch,
  MailQuery,
  MailSink,
  MailWaitOptions,
  Message,
  TestApiClient,
  WireMessage,
} from '../../types.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A wire message as tests see it: codes wrapped so they cannot be printed. */
export function toMessage(wire: WireMessage): Message {
  const codes = (wire.codes ?? []).filter(Boolean).map((c, i) => new Secret(c, `code ${i + 1} in mail ${wire.id}`));
  return { ...wire, links: wire.links ?? [], codes };
}

/** Does a message match? A RegExp is tested against the subject, the kind and the links. */
export function messageMatches(message: Message, match: MailMatch): boolean {
  if (typeof match === 'function') return match(message);
  return match.test([message.subject, message.kind ?? '', ...message.links].join('\n'));
}

/** Poll `list` until a message matches, newest first; the sinks share this. */
export async function pollForMessage(
  list: (query: MailQuery) => Promise<Message[]>,
  match: MailMatch,
  options: MailWaitOptions,
  describe: string,
  intervalMs = 1000,
): Promise<Message> {
  const { timeoutMs = 20_000, ...query } = options;
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  for (;;) {
    const messages = await list(query);
    seen = messages.length;
    const hit = messages.find((m) => messageMatches(m, match));
    if (hit) return hit;
    if (Date.now() >= deadline)
      throw new Error(
        `no mail matching ${String(match)} for ${describe} reached the sink in ${timeoutMs} ms (${seen} seen)`,
      );
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

export interface TestApiMailOptions {
  api: TestApiClient;
  /** the handle whose address this is in the worker's namespace (`handleForAddress` in core/catalog.ts), or null */
  handleFor: (address: string) => string | null;
  /** injected in tests */
  intervalMs?: number;
}

export function testApiMailSink(options: TestApiMailOptions): MailSink {
  const messages = async (address: string, query: MailQuery = {}): Promise<Message[]> => {
    const handle = options.handleFor(address);
    if (!handle)
      throw new Error(
        `the test-api mail sink reads mail of test accounts only; ${address} is not one in this namespace`,
      );
    const { data } = await options.api.call<{ messages: WireMessage[] }>('personaMessages', {
      params: { handle },
      query: { since: query.since, kind: query.kind, limit: query.limit ?? 10 },
    });
    return (data.messages ?? []).map(toMessage);
  };
  return {
    name: 'test-api',
    messages,
    waitFor(address, match, waitOptions = {}) {
      return pollForMessage((q) => messages(address, q), match, waitOptions, address, options.intervalMs);
    },
  };
}
