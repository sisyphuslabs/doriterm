# Contributing

Changes land on `dev` through a pull request, and `dev` requires three checks: `Check`, `Relay e2e` and `Web e2e`.

## Checks

`bun run check` runs the type checker, the linter, the formatter check, the API codegen check and the tests, which is what
`Check` runs apart from its `apps/web` build. `bun run --cwd apps/web test:e2e` runs the browser suite `Web e2e` runs
against a real `hc`; the job also runs it twice at once with `test:e2e:two-runs`.

`Relay e2e` runs the suites in `tests/relay`: this repository's host and client against the relay at the commit
`relay-pin.json` names, plus a browser spec that pairs two hosts through the mesh. That relay lives in a private
repository, so the job needs the `DORIFACE_RELAY_READ_TOKEN` secret, which only a run inside this repository receives.

If you have access to the relay, `RELAY_REPO=<owner>/<name> bun run relay:test` runs the same suites locally; the
checkout lands in `.relay`. `bun run check` does not need it.

## Pull requests from forks

GitHub gives a pull request from a fork no secrets at all. `Check` and `Web e2e` run as usual, but `Relay e2e` cannot
fetch the private relay, so it does not run the suites and does not report the required check: it reports as
`Relay e2e (fork: not run)`, with a notice that says so. The required `Relay e2e` context therefore stays "Expected" and
the pull request cannot merge until the suites have run at that head inside this repository.

A maintainer arranges that run by bringing your commits here, so they are the ones you wrote:

```sh
git fetch origin pull/<number>/head:verify/<number>
git push origin verify/<number>
gh pr create --base dev --head verify/<number> --title '<your title>' --body 'Carries #<number>.'
```

That pull request runs every check, `Relay e2e` included. The maintainer reviews and merges it, then closes the fork
pull request with a link to the one that landed. Your commits keep your authorship.

If you have relay access, run `bun run relay:test` at your head and put the counts in a comment; a maintainer can do the
same. Either way the required check is only reported by a run inside this repository, since a check that a fork can
report is a check a fork can fake.

Do not change `.github/workflows/` in a pull request unless that is the point of the pull request: a run from a fork
uses the workflow files in the pull request, so a maintainer reads such a change on its own before trusting any check
it reports.

## Changelog

A pull request that changes what users get adds one line under `## Unreleased` in `CHANGELOG.md`, in the subsection it
belongs to: what changed for them in plain words, not how it was built, with the pull request number. The `Changelog`
check fails a pull request that changes a file under `apps/` or `packages/` (tests, e2e specs, fixtures, the showcase
and Markdown aside) and adds no such line. When nothing changes for users, a refactor or a build tweak, add the
`no-changelog` label; the check runs again on its own.

A release moves the Unreleased lines into a `## vX.Y.Z - YYYY-MM-DD` section. The release workflow refuses a tag whose
section is missing or has no lines, before it builds anything, and publishes the section as the release notes.

## Commits

One meaning per commit, in the imperative: `fix(web): ...`, `feat(host): ...`, `test(relay): ...`. Say why in the body
when the reason is not obvious from the diff, and keep generated files in the commit that changes them.
