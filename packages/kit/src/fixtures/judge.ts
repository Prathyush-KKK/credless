// Recording an answer a model wrote, from inside a test (judge/judge.ts says how it is held). The markers are checked
// at once; the rubric is scored after the run, by the judge stage, from the case file written here into the run's
// folder, so the case is scrubbed and scanned with the rest of the evidence before anything keeps it.
import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { redact } from '../core/secret.ts';
import {
  type Criterion,
  DEFAULT_THRESHOLD,
  GROUNDED_ANSWER,
  JUDGE,
  type JudgeCase,
  markerProblems,
  rubricProblems,
} from '../judge/judge.ts';
import { reportDirFor, slug } from './evidence.ts';

export interface AnswerToJudge {
  /** who the answer was given to: a persona id or its handle */
  persona: string;
  question: string;
  answer: string;
  /** what is true for this persona, the whole truth the judge grades against */
  facts?: string[];
  /** words the answer must contain (a title it must name); checked now, case-insensitive */
  must?: string[];
  /** words it must not contain (another user's document); checked now */
  mustNot?: string[];
  /** default {@link GROUNDED_ANSWER}; `[]` for markers only */
  rubric?: readonly Criterion[];
  /** default 0.75 */
  threshold?: number;
  /** when one test records more than one answer: a name for each */
  step?: string;
}

/**
 * Record an answer for the judge and check its markers: a marker problem fails the test now, the rubric is scored
 * after the run. Text is redacted (registered secrets, credential shapes) before it is written.
 */
export function judgeAnswer(input: AnswerToJudge): JudgeCase {
  const info = test.info();
  const title = info.titlePath[info.titlePath.length - 1] ?? 'test';
  const rubric = [...(input.rubric ?? GROUNDED_ANSWER)];
  const invalid = rubricProblems(rubric);
  if (invalid.length) throw new Error(`[${input.persona}] the rubric is not usable: ${invalid.join('; ')}`);
  const c: JudgeCase = {
    id: `${slug(title)}--${slug(input.persona, 24)}${input.step ? `-${slug(input.step, 40)}` : ''}-${info.project.name}`,
    test: title,
    project: info.project.name,
    persona: input.persona,
    question: redact(input.question),
    answer: redact(input.answer),
    facts: (input.facts ?? []).map(redact),
    must: input.must ?? [],
    mustNot: input.mustNot ?? [],
    rubric,
    threshold: input.threshold ?? DEFAULT_THRESHOLD,
  };
  const dir = path.join(reportDirFor(info), JUDGE.cases);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${c.id}.json`);
  // A second answer under the same id would replace the first, which would then never be judged.
  if (fs.existsSync(file)) {
    throw new Error(
      `[${input.persona}] this test already recorded an answer as "${c.id}": give each answer a step name`,
    );
  }
  fs.writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`);
  info.annotations.push({ type: 'judge', description: c.id });
  const markers = markerProblems(c);
  if (markers.length)
    throw new Error(`[${input.persona}] the answer fails its markers:\n  - ${markers.join('\n  - ')}`);
  return c;
}
