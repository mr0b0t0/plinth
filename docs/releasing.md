# Releasing

A release publishes the same Worker in two forms: the npm CLI
[`@mr0b0t0/plinth`](https://www.npmjs.com/package/@mr0b0t0/plinth) and the Docker image
`ghcr.io/mr0b0t0/plinth`. A pushed tag `v<version>` does all of it through
[`.github/workflows/release.yml`](../.github/workflows/release.yml); nobody publishes from a
laptop.

The hosted instance is separate: it runs `main` and is deployed by a maintainer
([production.md](production.md)). The agent plugin has its own version
([distribution.md](distribution.md)).

## Cut a release

Maintainers only. On `main`, up to date with GitHub and with a clean working tree:

1. Check that `CHANGELOG.md` has the release's changes under **Unreleased**. Pull requests add
   these lines as they land; tidy them into a short list a user can read.
2. Pick the version. Before 1.0, a minor bump (`0.2.0`) for new features or anything a self-hoster
   must act on, a patch bump (`0.1.2`) for fixes. A pre-release (`0.2.0-rc.1`) is published under
   the npm tag `next` and gets no `latest` image tag.
3. Run `pnpm release 0.2.0 --dry-run` to see what it will do, then `pnpm release 0.2.0 --push`.

`pnpm release` sets the version in `packages/cli/package.json`, moves the **Unreleased** notes under
`## 0.2.0 (<date>)`, commits `Release v0.2.0`, tags `v0.2.0` and pushes both. Without `--push` it
stops after tagging and prints the push command.

## What the workflow does

1. **CI**: the full [`ci.yml`](../.github/workflows/ci.yml) (lint, typecheck, tests, build, the
   local and CLI smoke tests, the bundle secret scan, the OpenAPI and integrations checks, e2e). If
   it fails, nothing is published.
2. **Version check**: the tag must equal the CLI's `package.json` version.
3. **npm**: builds and runs `pnpm publish` with
   [provenance](https://docs.npmjs.com/generating-provenance-statements), so npm shows which commit
   and workflow built the package. A version that is already on npm is skipped, so a failed run can
   be re-run.
4. **Docker**: builds `linux/amd64` and `linux/arm64` and pushes `ghcr.io/mr0b0t0/plinth:<version>`,
   plus `<major>.<minor>` and `latest` for a normal release.
5. **GitHub release**: created from the version's `CHANGELOG.md` section.

Follow it with `gh run watch`, or on the repository's Actions tab.

## Secrets and access

- `NPM_TOKEN` is a granular npm access token with read and write access to `@mr0b0t0/plinth`,
  stored in the GitHub environment `npm`, which only `v*` tags may use. Granular tokens expire:
  when it does, make a new one on npmjs.com and run `gh secret set NPM_TOKEN --env npm` (it reads
  the value from standard input).
- The Docker job pushes with the workflow's own `GITHUB_TOKEN`; no other secret is involved.
- Only maintainers can create `v*` tags (a tag ruleset), and every action that handles a secret or
  a write token is pinned to a commit SHA.

## If something goes wrong

- **CI failed**: fix it on `main`, then delete the tag (`git push origin :v0.2.0 && git tag -d v0.2.0`)
  and cut the release again with the same version. Nothing was published.
- **npm published but a later job failed**: re-run the failed jobs from the Actions tab. npm is
  skipped because the version exists.
- **A bad version is out**: npm versions cannot be reused. Release a fixed patch version, and
  `npm deprecate @mr0b0t0/plinth@<bad> "<reason>"` the bad one.
