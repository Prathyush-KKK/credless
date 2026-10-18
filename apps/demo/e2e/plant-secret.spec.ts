// The acceptance test of the evidence pipeline, run by `credless demo --plant-secret` and by nothing else. It writes
// the demo's stand-in sign-in password into the test output ON PURPOSE (the log and an annotation), the way a careless
// `console.log` in a real suite would. The run must then fail: the scrub redacts the value wherever it landed, the scan
// counts it, SUMMARY.md says LEAK and the exit code is 1. The value is the demo's stand-in (fake-secrets.json), never a
// real secret. In any other project (the default demo run, the kit's own demo-e2e project) the test skips.
import { signinPasswordFromRunner } from 'credless/adapters';
import { about, expect, test } from './fixtures.ts';

test('P01 a planted secret: the stand-in sign-in password goes into the test output on purpose', async () => {
  test.skip(test.info().project.name !== 'plant-secret', 'runs only under credless demo --plant-secret');
  about(
    'demo, --plant-secret',
    'the value is redacted from what is kept, the scan counts it, SUMMARY.md says LEAK and the run exits 1',
  );
  // Read without deleting the runner's file: S1 reads it after this project (the suite depends on it) and deletes it.
  const password = signinPasswordFromRunner(undefined, { deleteAfter: false });
  expect(password !== null, 'the runner handed over the stand-in sign-in password').toBe(true);
  if (!password) return;
  console.log(`planted on purpose: ${password.reveal()}`);
  test.info().annotations.push({ type: 'planted-secret', description: password.reveal() });
});
