// G14b: a proxy flag in the browser's launch arguments is refused like a proxy option. `launchOptions` is a
// worker-scoped option, so it sits at the top of its own file.
import { expect, test } from '../../src/index.ts';

test.use({ launchOptions: { args: ['--proxy-server=http://127.0.0.1:9'] } });

test('G14b a proxy launch argument set by the test is refused: egress proxy bypassed', async ({ personas }) => {
  await expect(personas.open('owner')).rejects.toThrow(/egress proxy bypassed/);
});
