// An example credless test: two signed-in personas, evidence saved right after the checks, the server's answer
// checked as well as the screen. Replace the routes and the words with your app's; keep the shape.
import { about, expect, test } from 'credless';

test('two personas are signed in as themselves and see nothing of each other', async ({ personas, control }) => {
  about('credless quickstart', 'each persona lands on the home screen as themselves; the other persona is not shown');
  const [owner, member] = await personas.open('owner', 'member'); // two browsers, already signed in
  await owner.goto('/');
  await expect(owner.page.getByText(owner.persona.displayName)).toBeVisible();
  await expect(owner.page.getByText(member.persona.displayName)).toHaveCount(0);
  await owner.shot('home'); // evidence, right after the check; masked, scrubbed, on the contact sheet
  await member.goto('/');
  await expect(member.page.getByText(member.persona.displayName)).toBeVisible();
  await member.shot('home');
  expect((await member.api('/api/me')).http).toBe(200); // the server agrees, not only the screen
  expect((await control.state('member')).handle).toBe(control.handle('member'));
});
