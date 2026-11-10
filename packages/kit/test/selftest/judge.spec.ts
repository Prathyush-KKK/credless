// judgeAnswer() inside a real run (J01, J02) and the draft gate (J03). The judge stage itself is unit-tested
// (test/unit/judge.test.ts); here the answer is recorded where that stage reads it, in the run's own folder.
// biome-ignore lint/style/noRestrictedImports: this self-test reads the case file the judge stage will read
import fs from 'node:fs';
import path from 'node:path';
import { reportDirFor } from '../../src/fixtures/evidence.ts';
import { expect, judgeAnswer, test } from '../../src/index.ts';
import { JUDGE } from '../../src/judge/judge.ts';

test.describe('judging answers', () => {
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixture's dependencies from this pattern
  test('J01 an answer is recorded in the run folder, redacted, with its markers checked at once', async ({}, testInfo) => {
    const c = judgeAnswer({
      persona: 'owner',
      step: 'first',
      question: 'Which documents can I see?',
      answer: 'You can see one document, "Q3 plan", in the Team workspace.',
      facts: ['The person can see one document, "Q3 plan".'],
      must: ['Q3 plan'],
      mustNot: ['Payroll'],
    });
    const file = path.join(reportDirFor(testInfo), JUDGE.cases, `${c.id}.json`);
    expect(fs.existsSync(file), file).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      persona: 'owner',
      must: ['Q3 plan'],
      threshold: 0.75,
    });
    expect(testInfo.annotations).toContainEqual({ type: 'judge', description: c.id });
    // the same step twice would replace the first answer, which would then never be judged
    expect(() => judgeAnswer({ persona: 'owner', step: 'first', question: 'q', answer: 'a', rubric: [] })).toThrow(
      /already recorded an answer/,
    );
  });

  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixture's dependencies from this pattern
  test('J02 a rubric that cannot be scored is refused before anything is written', async ({}, testInfo) => {
    expect(() =>
      judgeAnswer({
        persona: 'owner',
        question: 'q',
        answer: 'a long enough answer',
        rubric: [{ id: 'grounded', ask: 'Is it grounded?', weight: 0 }],
      }),
    ).toThrow(/the rubric is not usable: the rubric's weight for "grounded" is 0/);
    const dir = path.join(reportDirFor(testInfo), JUDGE.cases);
    const mine = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('J02')) : [];
    expect(mine).toEqual([]);
  });
});

test('J03 a draft runs only with --drafts, and a failing draft never fails the run', { tag: '@draft' }, async () => {
  // Skipped in the self-tests' normal run. Under `run --drafts` it runs and fails, and the run still passes:
  // SUMMARY.md lists it under Drafts.
  expect(1 + 1, 'a draft that is not right yet').toBe(3);
});
