// Stand-in for the mail-sink factory of src/adapters/mail.ts (Task 1): the `test-api` sink over a client.
import type { MailSink, MailSinkRef, Message, TestApiClient, WireMessage } from '../../types.ts';

export function mailSinkFor(api: TestApiClient, ref: MailSinkRef = { sink: 'test-api' }): MailSink {
  if (ref.sink !== 'test-api') throw new Error(`mail sink ${ref.sink}: stand-in supports test-api only`);
  const toMessage = (m: WireMessage): Message => ({
    ...m,
    codes: m.codes.map((code) => ({ label: 'code', reveal: () => code })),
  });
  const messages = async (handle: string): Promise<Message[]> => {
    const { data } = await api.call<WireMessage[]>('personaMessages', { params: { handle } });
    return data.map(toMessage);
  };
  return {
    name: 'test-api',
    messages,
    waitFor: async (address, match) => {
      const found = (await messages(address)).find((m) => (match instanceof RegExp ? match.test(m.subject) : match(m)));
      if (!found) throw new Error('no matching message');
      return found;
    },
  };
}
