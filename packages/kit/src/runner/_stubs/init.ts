// Stand-in for the `init` body (Task 7: src/runner/init.ts, writing from templates/).
export interface InitAnswers {
  yes: boolean;
}

export async function writeTemplates(_dir: string, _answers: InitAnswers): Promise<string[]> {
  throw new Error('init: the templates land with Task 7 (packages/kit/templates, src/runner/init.ts)');
}
