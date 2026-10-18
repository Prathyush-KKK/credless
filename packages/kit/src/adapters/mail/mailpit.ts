// The Mailpit sink: `GET /api/v1/search?query=to:<addr>` then `GET /api/v1/message/{ID}`, mapped to the kit's
// Message. Mailpit's `after:` search term is not relied on; `since` is applied client-side on `Created`. Links and
// one-time codes are parsed out here so a test never reads raw mail.
import { type MailQuery, type MailSink, type Message, PATTERNS, type WireMessage } from '../../types.ts';
import { pollForMessage, toMessage } from './test-api.ts';

interface SearchHit {
  ID: string;
  Subject?: string;
  Created?: string;
  Tags?: string[];
  To?: Array<{ Address?: string }>;
}

interface FullMessage extends SearchHit {
  Date?: string;
  Text?: string;
  HTML?: string;
}

export interface MailpitOptions {
  /** the Mailpit UI/API origin, for example `http://127.0.0.1:8025` */
  url: string;
  /** `evidence.codeShape`: `digits6` (default) or a regular expression source */
  codeShape?: string;
  /** injected in tests */
  fetchImpl?: typeof fetch;
  intervalMs?: number;
}

const LINK = /https?:\/\/[^\s"'<>)\]]+/g;

function codePattern(shape: string | undefined): RegExp {
  if (!shape || shape === 'digits6') return /(?<![0-9])[0-9]{6}(?![0-9])/g;
  return new RegExp(shape, 'g');
}

/** Links (href and bare) and codes from a message's text and HTML, deduplicated and in order of appearance. */
export function extractFromBody(text: string, html: string, codes: RegExp): { links: string[]; codes: string[] } {
  const links = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) if (m[1]?.startsWith('http')) links.add(m[1]);
  for (const m of text.matchAll(LINK)) links.add(m[0].replace(/[.,;:]+$/, ''));
  const plain = html ? html.replace(/<[^>]+>/g, ' ') : '';
  const found = new Set<string>();
  for (const source of [text, plain]) for (const m of source.matchAll(codes)) found.add(m[0]);
  return { links: [...links], codes: [...found] };
}

export function mailpitMailSink(options: MailpitOptions): MailSink {
  const origin = options.url.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const codes = codePattern(options.codeShape);

  async function getJson<T>(path: string): Promise<T> {
    const response = await fetchImpl(`${origin}${path}`, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
    });
    if (!response.ok) throw new Error(`mailpit ${path} answered HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  const messages = async (address: string, query: MailQuery = {}): Promise<Message[]> => {
    const limit = query.limit ?? 10;
    const search = await getJson<{ messages?: SearchHit[] }>(
      `/api/v1/search?query=${encodeURIComponent(`to:${address}`)}&limit=${Math.max(limit * 2, 20)}`,
    );
    const wanted = address.toLowerCase();
    const hits = (search.messages ?? [])
      .filter((hit) => (hit.To ?? []).some((to) => to.Address?.toLowerCase() === wanted))
      .filter((hit) => query.since === undefined || createdSeconds(hit.Created) >= query.since)
      .filter(
        (hit) =>
          query.kind === undefined || (hit.Tags ?? []).some((t) => t.toLowerCase() === query.kind?.toLowerCase()),
      )
      .sort((a, b) => createdSeconds(b.Created) - createdSeconds(a.Created))
      .slice(0, limit);
    const out: Message[] = [];
    for (const hit of hits) {
      const full = await getJson<FullMessage>(`/api/v1/message/${encodeURIComponent(hit.ID)}`);
      const body = extractFromBody(full.Text ?? '', full.HTML ?? '', codes);
      const wire: WireMessage = {
        id: hit.ID,
        to: address,
        subject: full.Subject ?? hit.Subject ?? '',
        sentAt: createdSeconds(full.Date ?? hit.Created),
        links: body.links,
        codes: body.codes,
        ...(hit.Tags?.[0] ? { kind: hit.Tags[0] } : {}),
      };
      out.push(toMessage(wire));
    }
    return out;
  };

  return {
    name: 'mailpit',
    messages,
    waitFor(address, match, waitOptions = {}) {
      return pollForMessage((q) => messages(address, q), match, waitOptions, address, options.intervalMs);
    },
  };
}

function createdSeconds(created: string | undefined): number {
  const at = created ? Date.parse(created) : Number.NaN;
  return Number.isFinite(at) ? Math.floor(at / 1000) : 0;
}

/** For the self-tests: the default code shape as a RegExp source. */
export const DEFAULT_CODE_SHAPE = PATTERNS.code6.source;
