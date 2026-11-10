// The quickstart suite, the assistant: its answer is prose, the kind a model writes, so it is never string-matched.
// judgeAnswer() checks the markers now (the title it must name, the one it must not) and records the answer for the
// rubric, which a judge scores after the run (`credless demo --judge '["claude","-p"]'`; without one it is listed).
import { about, expect, judgeAnswer, test } from './fixtures.ts';

test('A1 the assistant names the document a member can see, and not one from a workspace they are not in', async ({
  personas,
  control,
}) => {
  about(
    'demo spec, assistant §1',
    "the answer names the shared workspace's document and never another workspace's; it claims nothing else",
  );
  const shared = await control.workspace({ owner: 'owner', members: ['member'], documents: { owner: 1 } });
  const elsewhere = await control.workspace({ owner: 'second-owner', documents: { 'second-owner': 1 } });
  const [member] = await personas.open('member');

  await member.goto('/ask');
  const question = 'Which documents can I see?';
  await member.page.getByLabel('Question').fill(question);
  await member.page.getByRole('button', { name: 'Ask', exact: true }).click();
  const reply = member.page.getByTestId('answer');
  await expect(reply).not.toBeEmpty();
  await member.shot('answer');

  judgeAnswer({
    persona: 'member',
    question,
    answer: await reply.innerText(),
    facts: [
      `This person can see exactly one document, "${shared.document(0).title}", in the workspace "${shared.name}".`,
      `"${elsewhere.document(0).title}" is in another workspace this person is not a member of.`,
    ],
    must: [shared.document(0).title],
    mustNot: [elsewhere.document(0).title],
  });
});
