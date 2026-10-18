// The quickstart suite, workspaces: invite by mail, what a guest never sees, what a removed member loses, and the
// accessibility findings the run keeps. Two browsers per test where two people are involved, each already signed in.
import type { A11yFinding } from 'credless';
import { about, expect, notSee, see, test, typeSecret } from './fixtures.ts';

test('W1 the owner invites a member by mail; the member joins with the link and the code', async ({
  personas,
  control,
}) => {
  about(
    'demo spec, workspaces §1',
    'the invite mail carries the link and the code; after joining, the member sees the workspace',
  );
  const ws = await control.workspace({ owner: 'owner', documents: { owner: 1 } });
  const [owner, member] = await personas.open('owner', 'member');

  await owner.goto(`/w/${ws.id}/members`);
  await owner.page.getByLabel('Email address').fill(member.persona.email);
  await owner.page.getByRole('button', { name: 'Send invite' }).click();
  await expect(owner.page.getByTestId('invite-row')).toContainText(member.persona.email);
  await owner.shot('invite-sent');

  const mail = await control.waitForMessage('member', /invited you to/);
  const link = mail.links[0];
  const code = mail.codes[0];
  expect(link, 'the invite mail carries the join link').toBeDefined();
  expect(code, 'the invite mail carries the code').toBeDefined();
  if (!link || !code) return;
  await member.goto(new URL(link).pathname);
  await see(member.page.locator('body'), `${owner.persona.firstName} invited you to ${ws.name}`);
  await typeSecret(member.page.getByLabel('Code'), code);
  await member.page.getByRole('button', { name: 'Join workspace' }).click();
  await see(member.page.getByTestId('join-message'), `You're in ${ws.name}`);
  await member.shot('joined');

  await member.goto(`/w/${ws.id}`);
  await expect(member.page.getByRole('heading', { name: ws.name })).toBeVisible();
  await member.shot('workspace');
  expect((await control.state('member')).state.workspaces).toEqual([{ id: ws.id, role: 'member' }]);
  expect((await control.refresh(ws)).invite(member.persona.email).state).toBe('JOINED');
});

test('W2 a guest sees nothing of a workspace: not the page, not the document, not the API', async ({
  personas,
  control,
}) => {
  about(
    'demo spec, workspaces §2',
    'the guest gets Not found on the workspace and the document, no search hits, and 404 from the API',
  );
  const ws = await control.workspace({ owner: 'owner', documents: { owner: 1 } });
  const doc = ws.document(0);
  const [guest] = await personas.open('guest');
  guest.guard.expectStatus(/\/api\/(workspaces|documents)\/\d+$/, 404); // expected: that is the point of the test

  await guest.goto(`/w/${ws.id}`);
  await expect(guest.page.getByText('Not found')).toBeVisible();
  await notSee(guest.page.locator('body'), ws.name);
  await guest.shot('workspace-not-found');
  await guest.goto(doc.path);
  await expect(guest.page.getByText('Not found')).toBeVisible();
  await notSee(guest.page.locator('body'), doc.title);
  await guest.shot('document-not-found');
  await guest.goto('/search');
  await guest.page.getByPlaceholder('Search').fill(doc.title);
  await guest.page.getByPlaceholder('Search').press('Enter');
  await expect(guest.page.getByText('No results')).toBeVisible();
  await guest.shot('search-empty');

  expect((await guest.api(`/api/workspaces/${ws.id}`)).http).toBe(404);
  expect((await guest.api(`/api/documents/${doc.id}`)).http).toBe(404);
  const search = await guest.api<{ results: unknown[] }>(`/api/search?q=${encodeURIComponent(doc.title)}`);
  expect(search.data?.results).toEqual([]);
  expect((await control.state('guest')).state.workspaces).toEqual([]);
});

test('W3 a removed member loses access to the workspace document', async ({ personas, control }) => {
  about('demo spec, workspaces §3', 'after removal the member gets Not found on the document and no search hits');
  const ws = await control.workspace({ owner: 'owner', members: ['member'], documents: { owner: 1 } });
  const doc = ws.document(0);
  const [owner, member] = await personas.open('owner', 'member'); // two browsers, already signed in
  await member.goto(doc.path);
  await expect(member.page.getByRole('heading', { name: doc.title })).toBeVisible();
  await member.shot('document-before');
  await owner.goto(`/w/${ws.id}/members`);
  await owner.page.getByRole('button', { name: `Remove ${member.persona.displayName}` }).click();
  await expect(owner.page.getByText(member.persona.displayName)).toHaveCount(0);
  await owner.shot('members-after');
  member.guard.expectStatus(new RegExp(`/api/documents/${doc.id}$`), 404); // expected, with a reason in the title
  await member.page.reload();
  await expect(member.page.getByText('Not found')).toBeVisible();
  await member.shot('document-after');
  expect((await member.api(`/api/documents/${doc.id}`)).http).toBe(404); // the server agrees, not only the screen
  expect((await control.state('member')).state.workspaces).toEqual([]);
});

test('F01 a removed member loses every way in: the page, search and the API; the upload stays', async ({
  personas,
  control,
}) => {
  about(
    'demo spec, workspaces §3',
    'the removed member finds nothing by page, search or API; the document stays with the workspace',
  );
  const ws = await control.workspace({ owner: 'owner', members: ['member'], documents: { member: 1 } });
  const doc = ws.document(0);
  const [owner, removed] = await personas.open('owner', 'member');

  await removed.goto(doc.path);
  await expect(removed.page.getByRole('heading', { name: doc.title })).toBeVisible();
  await owner.goto(`/w/${ws.id}/members`);
  await owner.page.getByRole('button', { name: `Remove ${removed.persona.displayName}` }).click();
  await expect(owner.page.getByText(removed.persona.displayName)).toHaveCount(0);
  await owner.shot('members-after');

  removed.guard.expectStatus(new RegExp(`/api/documents/${doc.id}$`), 404);
  await removed.page.reload();
  await expect(removed.page.getByText('Not found')).toBeVisible();
  await removed.shot('document-after');
  await removed.goto('/search');
  await removed.page.getByPlaceholder('Search').fill(doc.title);
  await removed.page.getByPlaceholder('Search').press('Enter');
  await expect(removed.page.getByText('No results')).toBeVisible();
  await removed.shot('search-after');

  expect((await removed.api(`/api/documents/${doc.id}`)).http).toBe(404);
  expect((await control.state('member')).state.workspaces).toEqual([]);
  const after = await control.refresh(ws);
  expect(after.member('member').state).toBe('REMOVED');
  expect(after.documentsBy('member')).toHaveLength(1); // the upload stays with the workspace, credited to the member
  expect((await control.state('member')).state.notifications).toContainEqual(
    expect.objectContaining({ type: 'workspace.removed' }),
  );
});

test('F04 accessibility findings are kept as evidence', async ({ personas }) => {
  about('demo spec, search', 'axe reports the unnamed search button; the run keeps it as evidence, not as a failure');
  const [guest] = await personas.open('guest');
  await guest.goto('/search');
  const findings = await guest.a11y('search');
  // the demo's search button has no name on purpose: axe says so, and the run keeps it as evidence
  expect(findings.map((f: A11yFinding) => f.id)).toContain('button-name');
  expect(findings.find((f: A11yFinding) => f.id === 'button-name')?.impact).toBe('critical');
  await guest.shot('search');
});
