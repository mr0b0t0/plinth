# Publishing from CI

A pipeline can publish its output to Plinth on every run: a coverage report, a benchmark page,
docs previews, a nightly report. Each run becomes the next version of one artifact, so:

- the link stays the same, and always shows the latest run;
- every run is kept as a version, with the commit it came from in its note;
- the compare view shows what changed between two runs, rendered side by side;
- the artifact is private until you share it, like everything published to Plinth.

On GitHub use the Action `mr0b0t0/plinth/publish`. Anywhere else (GitLab CI, a cron job, any
shell) use the CLI with the same options.

## Make a token

Use a token limited to the artifact. It can read that artifact and publish new versions of it,
and nothing else: it cannot create artifacts, open or change any other artifact, share, rename,
restore or delete, or read comments, shared data and view counts. If it leaks, the most it can do
is publish a version, which anyone with edit rights can revert.

1. Open the artifact in Plinth, then **Settings**, then **Publish from CI**.
2. Choose **Create a token for this artifact**. Copy the token: it is shown once. The dialog also
   shows the workflow step with the artifact's id filled in.

The owner and editors of an artifact can make such a token. The Connections page lists it as
"Only <title>" and revokes it like any other token. Deleting the artifact revokes it, and removing
your access to the artifact stops it.

**No artifact yet?** Publish the first version once, then make the token for it:

- locally: `npx @mr0b0t0/plinth@0.6.0 publish dist` (it signs you in in the browser and prints the
  link), or
- from CI with an account-wide token from **Connections** (under "Advanced"): without `id`, the
  first run creates a private artifact and the job summary prints its id. Then switch to a token
  limited to it and revoke the account-wide one.

## Store it as a secret

- **GitHub**: Settings › Secrets and variables › Actions › New repository secret, named
  `PLINTH_TOKEN`. An environment secret behind branch protection is better still: only the
  branches you allow can use it.
- **GitLab**: Settings › CI/CD › Variables, `PLINTH_TOKEN`, masked and protected.

Never put the token in the repository or in a workflow file.

## GitHub Actions

```yaml
name: Coverage report
on:
  push:
    branches: [main]
  schedule:
    - cron: "15 3 * * *"
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: plinth-coverage
  cancel-in-progress: false
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4 # pin by commit SHA in your own workflows
      - run: npm ci && npm test -- --coverage
      - id: plinth
        uses: mr0b0t0/plinth/publish@v0.6.0
        with:
          path: coverage/lcov-report
          token: ${{ secrets.PLINTH_TOKEN }}
          id: k3x9mq2v7d8p4t6w1n5r
      - name: Print the link
        env:
          REPORT_URL: ${{ steps.plinth.outputs.version-url }}
        run: echo "Report: $REPORT_URL"
```

- `k3x9mq2v7d8p4t6w1n5r` stands for your artifact's id; the **Publish from CI** dialog shows this
  step with it filled in.
- `concurrency` keeps two runs from publishing at once. If they still race, the second stops
  with a conflict instead of overwriting the first (below).
- `actions/checkout` gives scheduled and manual runs a commit subject for the version note.
- The Action runs on Linux and macOS runners and needs nothing installed: it runs the CLI client
  from the same release.
- Pin the Action to a release tag, as above, or to that tag's commit SHA, and let Dependabot
  (the `github-actions` ecosystem) propose updates. There is no moving `v1` tag.

> **Outputs are untrusted input.** Every output comes from the server or from the artifact, and
> `json` carries the artifact's title, which anyone with edit rights chose. Never write
> `${{ steps.plinth.outputs.* }}` inside `run:` or `script:`: GitHub pastes it into the script
> before the shell runs, so a title like `"; curl ... #` would run. Pass outputs through `env:`
> and read `"$NAME"` in the shell or `process.env.NAME` in `actions/github-script`, and parse
> `json` with `jq` from an environment variable, never with `eval`.

A comment on the pull request, the same way:

```yaml
      - uses: actions/github-script@v7 # pin by commit SHA in your own workflows
        env:
          REPORT_URL: ${{ steps.plinth.outputs.version-url }}
        with:
          script: |
            await github.rest.issues.createComment({
              ...context.repo,
              issue_number: context.issue.number,
              body: `Report: ${process.env.REPORT_URL}`,
            });
```

Tolerating a race (the next run publishes the newer commit):

```yaml
      - id: plinth
        continue-on-error: true
        uses: mr0b0t0/plinth/publish@v0.6.0
        with:
          path: dist
          token: ${{ secrets.PLINTH_TOKEN }}
          id: k3x9mq2v7d8p4t6w1n5r
      - if: steps.plinth.outputs.outcome == 'conflict'
        run: echo "Another run published first; the next run publishes this commit."
```

`if:` expressions are evaluated by GitHub, not pasted into a shell, so comparing an output there
is safe.

### Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `token` | required | A Plinth personal access token, from a secret |
| `path` | required | A build folder with `index.html` (or `content.md`) at its top, or one `.html` or `.md` file |
| `id` | empty | The artifact to update (id or slug). Empty: the token's artifact if it is limited to one, else a new private artifact |
| `url` | `https://plinth.aconite.io` | The Plinth instance the token was made on |
| `title` | empty | Title of a new artifact (ignored on updates) |
| `category` | empty | Category of a new artifact (ignored on updates; change it on the Settings page) |
| `note` | empty | The version note. Empty: the commit subject and short SHA. `-`: no note |
| `link-run` | `false` | Append this run's URL to the note |
| `base-version` | empty | Publish only if the artifact is still at this version. Needs an artifact to update (`id`, or a token limited to one): without one the step fails with exit code 2 and creates nothing |
| `include-maps` | `false` | Also send source maps |
| `dry-run` | `false` | Check the build and report what would be sent; publish nothing |
| `fail-on-warnings` | `false` | Fail the step when the publish reports warnings (it is still published). `not_scanned` and `live_draft` need no action and never fail it |
| `summary` | `true` | Write a job summary with the links |

The default note is the subject of the commit that triggered the run (or the pull request's
title), then the short SHA, at most 500 characters (counted as the server counts them: an emoji
takes two).

### Outputs

| Output | What it holds |
| --- | --- |
| `id`, `slug` | The artifact |
| `version` | The version now current |
| `url` | The artifact's page (always the latest version) |
| `version-url` | This version's permanent page |
| `compare-url` | The rendered comparison with the previous version (empty for version 1) |
| `outcome` | `published`, `nothing_to_publish`, `already_published`, `dry_run`, `conflict`, `unknown` or `error` |
| `current-version` | On a conflict, the version someone else published |
| `verified` | `true` when every file was read back and matched |
| `warnings` | The number of publish warnings to fix (missing files, blocked hosts). Not counted: `not_scanned` (some files were not checked) and `live_draft` (people have unsaved edits on the page of a doc or a sheet; the version was published, and nothing was overwritten) |
| `json` | The CLI's `--json` output (untrusted, see above) |

## Pull requests and forks

GitHub does not give secrets to workflows that run for pull requests from forks, so those runs
cannot publish. Never use `pull_request_target` to build and publish a fork's code with the
token: that runs code you have not reviewed with your secret. A preview per pull request needs one
artifact per pull request, and so an account-wide token; prefer publishing from `main` only.

## GitLab CI

```yaml
publish-report:
  image: node:24-bookworm-slim
  stage: deploy
  resource_group: plinth-report        # one publish at a time
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    - if: $CI_PIPELINE_SOURCE == "schedule"
  allow_failure:
    exit_codes: [3]                    # another publish raced this one
  script:
    - npx --yes @mr0b0t0/plinth@0.6.0 publish public --id "$PLINTH_ARTIFACT"
        --note "$CI_COMMIT_TITLE ($CI_COMMIT_SHORT_SHA)" --json > plinth.json
  artifacts:
    when: always
    paths: [plinth.json]
```

`PLINTH_TOKEN`, `PLINTH_ARTIFACT` (the artifact's id) and, for your own instance, `PLINTH_URL` come
from CI/CD variables; schedules from CI/CD › Schedules. The variables are quoted, so a commit title
is one argument and never shell code. `npx` downloads the whole CLI package, so cache `~/.npm`.
`plinth.json` holds the artifact's title: treat it as untrusted, as on GitHub.

## cron on a server

```sh
#!/bin/sh
# /usr/local/bin/publish-report, run by the report user's crontab:
# 15 3 * * * /usr/local/bin/publish-report >>"$HOME/publish-report.log" 2>&1
set -eu
umask 077
# A fresh directory only this user can open, removed on every exit: another local user cannot
# pre-create, swap or link the file that gets published.
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
PLINTH_TOKEN="$(cat /etc/plinth/report.token)"   # mode 0600, owned by the report user
export PLINTH_TOKEN
/opt/report/build > "$out/index.html"
status=0
plinth publish "$out" --id k3x9mq2v7d8p4t6w1n5r --note "nightly $(date -u +%F)" || status=$?
if [ "$status" -eq 3 ]; then
  echo "publish-report: another publish raced this one; tomorrow's run will publish" >&2
fi
exit "$status"
```

Install the CLI once with `npm install -g @mr0b0t0/plinth@0.6.0`, so nothing is downloaded at
3 a.m. `|| status=$?` keeps `set -e` from exiting before the exit code is read. With a token
limited to one artifact, `--id` may be left out.

## Exit codes and the JSON output

| Exit code | Action `outcome` | Meaning |
| --- | --- | --- |
| 0 | `published`, `nothing_to_publish`, `already_published`, `dry_run` | Done. With `base-version`, a build that matches the current version (or the one after it, published by an earlier run whose answer was lost) sends nothing |
| 1 | `error`, `unknown` | Failed. `unknown`: the build was sent but the answer was lost, so it may have been published. Re-run with `base-version` set to the version the build was sent against (the summary names it): the re-run sends nothing if the build landed and stops with a conflict if someone else published first. A re-run without `base-version` publishes the build again, and one without `id` creates another artifact |
| 2 | `error` | A usage problem: a bad input, a path that is not a build folder or an `.html` or `.md` file, or an `id` other than the token's artifact |
| 3 | `conflict` | Nothing was published. Without `base-version`: someone published a newer version while this run was sending; re-run the job. With `base-version`: the artifact is past that version; check what changed and set `base-version` to the current version (`current-version`), since a re-run with the same one stops the same way. Never retried |

With `--json`, the CLI prints one JSON object on stdout for every outcome: the result
(`id`, `slug`, `version`, `url`, `content_url`, `stored`, `warnings`, `verified`, `title`), or
`{"published": "unknown", "id": ..., "upload_id": ...}` when the answer was lost, or, for any other
failure:

```json
{ "ok": false, "exit_code": 3, "outcome": "conflict", "message": "...", "current_version": 8 }
```

`outcome` is `conflict`, `usage` or `error`; `current_version` is set on a conflict.

## Your own instance

Set `url:` (the Action) or `PLINTH_URL` (the CLI) to your instance's app origin, for example
`https://plinth.example.com`. A token works only on the instance it was made on, and the CLI never
sends it anywhere else.

## What viewers see

Everyone who can view the artifact sees its version history: each version's note (by default the
commit subject and short SHA) and who published it (the token's name). `link-run` adds the run's
URL, which names the repository, so it is off by default. The job summary on GitHub shows the
links, the version and the warnings, and never the token.
