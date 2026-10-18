# Case list template

Write this before any test, in the document that tracks the work or next to the feature's spec. One row per case.

| Id | Source | Personas | Setup (control) | Steps (UI) | Expected | Layer |
|---|---|---|---|---|---|---|
| W3 | workspaces spec, section 3 | owner, member | workspace of owner with member; owner uploads 1 document | member opens the document; owner removes member; member reloads, searches | Not found; no results; the API answers 404 for the document and lists no workspace | e2e |
| W-perm-2 | derived from code: `WorkspaceWriteGuard` refuses uploads when the plan is suspended | owner, member | workspace with plan `suspended` | member opens the workspace home | upload disabled; the API refuses (403) | backend + e2e |
| W-copy-1 | design notes, "empty states" | owner | a workspace with no documents | owner opens the documents list | the empty-state copy, word for word | component |

## What to cover

- **Happy path** for each role that can do the thing.
- **Permissions per role**: owner, member, guest, outsider, a second workspace's owner, a removed member.
- **State changes**: before and after (invited, joined, removed, left; active, suspended, closed).
- **Limits and expiry**: seat limits, wrong-code attempts, invite expiry, trial or grace end.
- **Error copy**: the words a person sees when it goes wrong.
- **Effects on other accounts**: what everyone else sees after the action (the removed member, the outsider, the
  owner's notifications, the other workspace).

## Rules for the Source column

- A document and its section or case number, or a row of the decisions log.
- "derived from code: `<file, class or rule>`" when no document says it; a person confirms it before it counts.
- A product question (nobody has decided) is not a case: list it as `product:` in the report.

## Rules for the Layer column

`backend`, `component` or `e2e` (`method.md` step 3). Only `e2e` rows become tests in `e2e/`; the others are
handed to the suite that owns them, with the row as the specification.
