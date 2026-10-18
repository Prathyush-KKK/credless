// The one UI sign-in test. Its password reaches the test as a Secret from the runner (a 0600 file in staging, or the
// self-tests' CREDLESS_SIGNIN_PASSWORD stand-in) and goes into the field with typeSecret(): a fill() step is titled
// with its value and the HTML report keeps step titles. Traces are off for this file (a trace records the arguments
// of every call; the runner's scrub is the last line, not the first), the field is emptied before the browser
// closes, and password fields are masked in every shot.
import { signinPasswordFromRunner } from 'credless/adapters';
import { about, clearSecretField, expect, see, test, typeSecret } from './fixtures.ts';

test.use({ trace: 'off' });

test('S1 the sign-in persona signs in with email and password', async ({ personas }) => {
  about('demo spec, sign-in', 'the password goes in with typeSecret, the field is masked, and the app lands signed in');
  const password = signinPasswordFromRunner();
  test.skip(
    !password,
    'no sign-in password from the runner (CREDLESS_SIGNIN_PASSWORD_FILE or CREDLESS_SIGNIN_PASSWORD)',
  );
  if (!password) return;
  const eve = await personas.openSignedOut('signin');
  await eve.goto('/login');
  const field = eve.page.getByLabel('Password');
  try {
    await eve.page.getByLabel('Email').fill(eve.persona.email);
    await typeSecret(field, password);
    await eve.shot('password-entered'); // the field is masked
    await eve.page.getByRole('button', { name: 'Sign in' }).click();
    await see(eve.page.getByRole('heading', { level: 1 }), `Hello ${eve.persona.firstName}`);
    await eve.shot('signed-in');
  } finally {
    // the app empties and drops the field on success; on a failure it is still there with the value
    if ((await field.count()) > 0) await clearSecretField(field);
  }
  expect((await eve.api('/api/me')).http).toBe(200);
});
