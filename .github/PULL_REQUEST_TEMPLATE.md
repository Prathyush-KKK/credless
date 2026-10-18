## What and why

<!-- One change, one pull request. Link the issue or the rfc. -->

## Checklist

- [ ] No secret value, cookie, code or real person's data in the diff, the tests, the fixtures or the description.
- [ ] No organisation-specific string (`node scripts/org-gate.mjs` is clean with my private list).
- [ ] `pnpm test` is green locally (check plus the self-tests through the runner).
- [ ] A changeset is included for anything a user sees (`pnpm changeset`), or this is internal only.
- [ ] Contract change? `contract/core.openapi.yaml`, `CORE_ROUTES`, the client, the broker allowlist, the demo's
      handler and the docs move together (`pnpm contract:check`).
- [ ] Skill change? Edited under `packages/kit/skills/e2e-testing/`, then `pnpm skill:sync`.
- [ ] Security model, config schema or adapter interface change? There is an `rfc` issue and it was open a week.
- [ ] Touches `plugins/`, `action/` or `packages/kit/src/runner/`? Two reviews, and the threat model row in
      `SECURITY.md` is still true.
- [ ] Commits are signed off (`git commit -s`, DCO).

## How to verify

<!-- The command a reviewer runs and what they should see. For an adapter: the mock it passes and the stack you ran it against. -->
