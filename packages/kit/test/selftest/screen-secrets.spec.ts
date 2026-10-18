// Secrets on screen: a password typed without reaching any report (E04), and the FAILED triage screenshot of a
// test that broke while a one-time code was showing, masked like every other screenshot (E05a/b).
//
// The run's own scan backs these up: a self-test run's evidence is scanned for the demo's stand-in password and key
// like a real run's for the real ones, so a step title or log line that carried the value would fail the self-tests.
import { signinPasswordFromRunner } from '../../src/core/secret.ts';
import { evidenceExists, shotPath, shotPixel } from '../../src/fixtures/evidence.ts';
import { clearSecretField, ENV, expect, Secret, see, test, typeSecret } from '../../src/index.ts';

/** The mask colour, DEFAULTS.maskColor, as pixels. */
const MASK = [255, 0, 255];

test('E04 typeSecret puts a password into the field (input event and all), masked, then cleared', async ({
  personas,
}) => {
  const s = await personas.openSignedOut('signin');
  const password = signinPasswordFromRunner();
  if (!password) throw new Error(`the self-test harness sets ${ENV.SIGNIN_PASSWORD} to the demo's stand-in`);
  const length = password.reveal().length;
  await s.goto('/__demo/password');
  const field = s.page.locator('input[type="password"]').first();
  try {
    await typeSecret(field, password);
    await see(s.page, `typed ${length} characters`);
    const file = await s.shot('password-entered');
    const box = await field.boundingBox();
    if (!box) throw new Error('the password field has no box');
    const dpr = await s.page.evaluate(() => window.devicePixelRatio);
    expect(
      await shotPixel(s.page, file, box.x + box.width / 2, box.y + box.height / 2, dpr),
      'the password field is masked',
    ).toEqual(MASK);
  } finally {
    await clearSecretField(field);
  }
  await expect(field).toHaveValue('');
  expect(String(password)).not.toContain(password.reveal());
  expect(JSON.stringify({ password })).not.toContain(password.reveal());
});

test.describe('the FAILED screenshot of a test that broke while a code was showing', () => {
  test.describe.configure({ mode: 'serial' });
  let marker: { file: string; x: number; y: number; dpr: number; project: string } | null = null;

  test('E05a a test fails while a one-time code is on screen', async ({ personas, sensitive }, testInfo) => {
    test.fail(
      true,
      'expected: fails on purpose while the code is showing, so the teardown takes the FAILED screenshot',
    );
    // a code in play, as the control API would hand it out (its onSecret feeds the same registry)
    const code = new Secret('418203', 'self-test code');
    sensitive.add(code);
    const [p] = await personas.open('owner');
    await p.goto('/');
    const shown = `${code.reveal().slice(0, 3)} ${code.reveal().slice(3)}`;
    await p.page.evaluate((text) => {
      const el = document.createElement('div');
      el.id = 'code';
      el.textContent = text;
      el.style.cssText =
        'position:fixed;top:40px;left:40px;padding:12px 24px;font-size:32px;background:#fff;color:#000';
      document.body.append(el);
    }, shown);
    await expect(p.page.locator('#code')).toBeVisible();
    const box = await p.page.locator('#code').boundingBox();
    if (!box) throw new Error('the code has no box');
    const dpr = await p.page.evaluate(() => window.devicePixelRatio);
    marker = {
      file: shotPath(testInfo, 'owner', 'FAILED'),
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      dpr,
      project: testInfo.project.name,
    };
    await see(p.page, 'A text that is not on this screen', 500);
  });

  test('E05b its FAILED screenshot exists and the code in it is masked', async ({ personas }) => {
    if (!marker) throw new Error('E05a did not run first');
    const { file, x, y, dpr, project } = marker;
    expect(file).toMatch(
      new RegExp(`E05a-a-test-fails-while-a-one-time-code-is-on-screen--owner-FAILED-${project}\\.png$`),
    );
    expect(evidenceExists(file)).toBe(true);
    const p = await personas.openSignedOut('guest');
    expect(await shotPixel(p.page, file, x, y, dpr), 'the code is painted over in the mask colour').toEqual(MASK);
  });
});
