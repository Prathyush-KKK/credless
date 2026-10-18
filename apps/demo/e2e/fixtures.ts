// The demo suite's `test`: the kit's test with `control` typed as the demo's extension (the runtime object already
// is one, through `control.module` in credless.config.ts). Specs import from here so `control.workspace(...)` types.
import { test as base, type StateControl } from 'credless';
import type { DemoControl } from './demo.control.ts';

export { about, clearSecretField, expect, notSee, see, typeSecret } from 'credless';
export type { DocumentRef, WorkspaceFixture } from './demo.control.ts';

export const test = base.extend<{ control: DemoControl }>({
  control: async ({ control }: { control: StateControl }, use: (control: DemoControl) => Promise<void>) => {
    await use(control as DemoControl);
  },
});
