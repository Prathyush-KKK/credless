// The kit's main entry (plan §3, src/index.ts): `test`, `expect`, `about`, `typeSecret`, `clearSecretField`,
// `see`/`notSee`, `Secret` and the shared types.
export { CANARY_HOST, CLI_NAME, ENV_PREFIX, KIT_NAME } from './brand.ts';
export { Secret } from './core/secret.ts';
export { about } from './fixtures/about.ts';
export { notSee, see, type TextMatch } from './fixtures/dom.ts';
export { clearSecretField, typeSecret } from './fixtures/evidence.ts';
export { expect, type KitSelfTestOptions, type KitTest, test } from './fixtures/index.ts';
export { type AnswerToJudge, judgeAnswer } from './fixtures/judge.ts';
export {
  type Criterion,
  type CriterionScore,
  DEFAULT_THRESHOLD,
  GROUNDED_ANSWER,
  type JudgeCase,
  type JudgeResults,
  type JudgeStatus,
  type Settled,
  type Verdict,
} from './judge/judge.ts';
export * from './types.ts';
