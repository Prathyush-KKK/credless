# Changesets

One publishable package (`credless`, in `packages/kit`); the workspace root and `apps/demo` are private and are
neither versioned nor tagged (`privatePackages` in `config.json`).

- A change a user sees gets a changeset: `pnpm changeset`, pick `patch`, `minor` or `major`, write the line the
  changelog will show. Before 1.0, `minor` is a breaking change and `patch` is everything else.
- On `main`, `.github/workflows/release.yml` keeps a "Version packages" pull request current. Merging it runs
  `changeset publish`: `npm publish` with `provenance: true` and `access: public` from `publishConfig`, through
  npm trusted publishing (the job's OIDC token; no npm token exists anywhere), followed by a GitHub build
  attestation of the tarball.
- One-time setup on npmjs.com: package `credless` > Settings > Trusted publishing > GitHub Actions, owner
  `Prathyush-KKK`, repository `credless`, workflow `release.yml`. Until that is done the publish step fails with a
  401 and nothing is tagged.
- Pre-release tags, if ever: `pnpm changeset pre enter next`, then the normal flow publishes under the `next` tag;
  `pnpm changeset pre exit` returns to `latest`.

Dry run before a release, locally: `pnpm changeset status --verbose`, `pnpm changeset version` on a branch (then
discard), and `pnpm --filter ./packages/kit publish --dry-run --no-git-checks` after `pnpm build`.
