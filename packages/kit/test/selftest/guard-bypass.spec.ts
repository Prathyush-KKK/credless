// G14: nothing replaces the per-context egress proxy. `proxy` is a worker-scoped option, so Playwright only accepts
// it at the top of a file; that is why this test lives apart from guard.spec.ts.
import { expect, test } from '../../src/index.ts';

test.use({ proxy: { server: 'http://127.0.0.1:9' } });

test('G14 a proxy option set by the test is refused: egress proxy bypassed', async ({ personas }) => {
  await expect(personas.open('owner')).rejects.toThrow(/egress proxy bypassed/);
  await expect(personas.openSignedOut('signin')).rejects.toThrow(/egress proxy bypassed/);
});
