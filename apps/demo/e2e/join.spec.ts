// The quickstart suite, joining: the link and the six-digit code, the lock after five wrong codes, and the code as
// a secret: typed with typeSecret, known to the `sensitive` fixture so every shot masks it, never printed.
import { about, expect, notSee, see, test, typeSecret } from './fixtures.ts';

test('W4 five wrong codes lock the link; after that the right code is refused too', async ({ personas, control }) => {
  about('demo spec, join §4', 'the fifth wrong code locks joining; the right code is refused; the owner is notified');
  const ws = await control.workspace({ owner: 'owner' });
  const [guest] = await personas.open('guest');
  guest.guard.expectStatus(/\/api\/join\//, 422); // wrong code
  guest.guard.expectStatus(/\/api\/join\//, 423); // locked

  await guest.goto(new URL(ws.joinUrl).pathname);
  const code = guest.page.getByLabel('Code');
  const join = guest.page.getByRole('button', { name: 'Join workspace' });
  const message = guest.page.getByTestId('join-message');
  for (let left = 4; left >= 1; left -= 1) {
    await code.fill('000000');
    await join.click();
    await see(message, `That code doesn't match. ${left} tries left.`);
  }
  await code.fill('000000');
  await join.click();
  await see(message, /Joining is locked/);
  await guest.shot('locked');

  expect(ws.joinCode).not.toBeNull();
  if (!ws.joinCode) return;
  await typeSecret(code, ws.joinCode);
  await join.click();
  await see(message, /Joining is locked/);
  await guest.shot('locked-right-code');

  expect((await control.refresh(ws)).locked).toBe(true);
  expect((await control.state('guest')).state.workspaces).toEqual([]);
  expect((await control.state('owner')).state.notifications).toContainEqual(
    expect.objectContaining({ type: 'workspace.join.locked' }),
  );
});

test('F02 join by link and code: a wrong code, then the right one, typed and never printed', async ({
  personas,
  control,
  sensitive,
}) => {
  about('demo spec, join §2', 'the wrong code is counted; the right one joins; the code is a masked secret throughout');
  const ws = await control.workspace({ owner: 'second-owner' });
  const [guest] = await personas.open('guest');
  guest.guard.expectStatus(/\/api\/join\//, 422);

  await guest.goto(new URL(ws.joinUrl).pathname);
  await see(guest.page.locator('body'), `${control.persona('second-owner').firstName} invited you to ${ws.name}`);
  const code = guest.page.getByLabel('Code');
  const join = guest.page.getByRole('button', { name: 'Join workspace' });
  await code.fill('000000');
  await join.click();
  await see(guest.page.getByTestId('join-message'), "That code doesn't match. 4 tries left.");
  await guest.shot('wrong-code');

  expect(ws.joinCode).not.toBeNull();
  if (!ws.joinCode) return;
  // boolean on purpose: a failing toContain would print the code in its message
  expect(sensitive.plain.includes(ws.joinCode.reveal()), 'the control registered the code for masking').toBe(true);
  await typeSecret(code, ws.joinCode);
  await expect(code, 'a one-time-code field is always masked').toHaveAttribute('data-sensitive', '');
  await join.click();
  await see(guest.page.getByTestId('join-message'), `You're in ${ws.name}`);
  await notSee(guest.page.locator('body'), ws.joinCode);
  await guest.shot('joined');
  expect((await control.state('guest')).state.workspaces).toEqual([{ id: ws.id, role: 'member' }]);
});

test('F03 the workspace code is a secret the shots mask', async ({ personas, control, sensitive }) => {
  about(
    'demo spec, link and code',
    'the owner sees the code in the 3+3 shape; the sensitive fixture finds it on the page, so the shot masks it',
  );
  const ws = await control.workspace({ owner: 'owner' });
  const [owner] = await personas.open('owner');
  await owner.goto(`/w/${ws.id}/link`);
  const shown = owner.page.locator('#code');
  await expect(shown).toHaveText(/^\d{3} \d{3}$/);
  expect(ws.joinCode).not.toBeNull();
  if (!ws.joinCode) return;
  const shownPlain = (await shown.innerText()).replace(/\s/g, '');
  expect(shownPlain === ws.joinCode.reveal(), 'the code shown is the one the control handed out').toBe(true);
  const masked = sensitive.locators(owner.page);
  expect(masked.length, 'the code on the page is found for masking').toBeGreaterThan(0);
  await owner.shot('link-and-code');
  expect(String(ws.joinCode)).toContain('[redacted]');
});
