# Contributing

Changes land on `dev` through a pull request, and `dev` requires three checks: `Check`, `Relay e2e` and `Web e2e`.

## From zero

Everything below is public: no account, token or repository access beyond a public clone. It is written for Linux
x86_64, and the `From zero` workflow runs these blocks exactly as written, in order, on a clean runner with no secrets
(`tests/ci/from-zero.ts`), so a step that stops working or starts to need something private fails there first. On macOS,
take the herdr-core archive for your machine from the same release (`herdr-core-macos-aarch64.tar.gz` or
`herdr-core-macos-x86_64.tar.gz`) and check it with `shasum -a 256`. You need `git`, `curl`, `tar` and `unzip` first.

Install Bun 1.4.4:

```sh from-zero
curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

Install herdr-core 0.1.21 as `hc`, checking the archive first:

```sh from-zero
mkdir -p "$HOME/.local/bin"
curl -fsSL https://releases.herdr.dev/core/0.1.21/herdr-core-linux-x86_64.tar.gz -o herdr-core.tar.gz
echo "78424755c10a40dde38a0bdb55c20ac19706e9ae05ed68fc2acf1fcff0d941c1  herdr-core.tar.gz" | sha256sum --check --strict
tar -xzf herdr-core.tar.gz -C "$HOME/.local/bin" herdr-core
ln -sf herdr-core "$HOME/.local/bin/hc"
export PATH="$HOME/.local/bin:$PATH"
hc --version
```

Clone the repository and install its dependencies:

```sh from-zero
git clone https://github.com/sisyphuslabs/doriterm.git
cd doriterm
```

```sh from-zero
bun install --frozen-lockfile
```

Run the type checker, linter, formatter check, API codegen check and every unit suite. The relay suites need the
private relay, so this prints one line saying they were skipped and why:

```sh from-zero
bun run check
```

Run the browser suite against a real `hc`. `playwright install --with-deps` installs Chromium's system libraries with
`sudo apt-get` each time it runs. The few specs that need the private relay are skipped, each with the same one-line
reason:

```sh from-zero
cd apps/web
bun run build
bunx playwright install --with-deps chromium
bun run test:e2e
bun run test:e2e:two-runs
```

That is everything `Check` and `Web e2e` run: the web build, the browser suite, and two short runs at once on their own
ports. The relay suites are optional for a contributor; with access to the private relay,
`RELAY_REPO=<owner>/<name> bun run relay:test` runs them (see below), and without it that command says so and stops.

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

## Screenshots

Images under `docs/` are public, so a capture shows the product and never the machine that took it.

- Take captures through the e2e hosts (`CAPTURE=1 bunx playwright test capture` in `apps/web`, or
  `bun run capture:readme`). Their cores announce the neutral name `studio` (`apps/web/e2e/host.ts` and
  `apps/web/e2e/fake-relay-host.ts` write it into the core's `core.json` before it starts), and their shells start with
  a prompt the spec sets (`$ `, or `demo@my-laptop:~/project$` in the relay captures), never the capturing account's.
- Before committing a shot, look where a machine shows through: the sidebar's machine row and the status bar (the host
  name), the terminal's prompt (account, host and working directory), and a space row's git facts (a branch name, a
  dirty marker or ahead/behind counts from the checkout that ran the capture).
- The `Capture text` check reads the text in every image a pull request adds or changes under `docs/` or
  `.github/assets/` and fails on an account at a host, a home directory or an internal run path
  (`tests/ci/capture-text.ts`). `bun tests/ci/capture-text.ts <image>...` runs it locally and needs `tesseract`. An
  example name in a capture uses `studio` for a core and `demo@my-laptop` for a prompt; the check's `NEUTRAL_NAMES` list
  holds the account and host names it accepts.

## Changelog

A pull request that changes what users get adds one file of its own, `changes/unreleased/<pr-number>.md`, and leaves
`CHANGELOG.md` alone. Before the pull request has a number, name the file for the branch in lowercase (`fix-paste.md`)
and rename it once it does. The file holds the section the change belongs to and one line saying what changed for users,
in plain words, not how it was built, with the pull request number:

```md
### Terminal

- A file pasted while a Korean syllable is still composing lands after that syllable. (#827)
```

A fragment may carry several `###` sections with several `- ` lines each; a long line can go on over lines indented two
spaces. The sections are the ones `CHANGELOG.md` uses, listed in `CANONICAL_HEADINGS` in
`.github/scripts/changelog-fragments.ts`: another spelling of one (`Mesh` for `Machine mesh`, `The phone` for
`Phone`) is written under the listed name, and a name outside the list is kept as written. `changes/README.md` has the
format.

Every pull request owns its own file, so a merge into `dev` never conflicts with the others, as lines under
`## Unreleased` did. A pull request that adds such a line still passes while open pull requests convert, the next time
they are touched.

The `Changelog` check fails a pull request that changes a file under `apps/` or `packages/` (tests, e2e specs,
fixtures, the showcase and Markdown aside) and adds no fragment, and fails any fragment the release could not place.
When nothing changes for users, a refactor or a build tweak, add the `no-changelog` label; the check runs again on its
own.

### Releasing

A release pull request sets the version in `apps/desktop/package.json` (and `bun.lock`), then runs

```sh
bun .github/scripts/changelog-assemble.ts
```

It writes the `## Unreleased` lines and every fragment into a `## vX.Y.Z - YYYY-MM-DD` section for that version (today
in UTC; `--date` sets another day) below an empty `## Unreleased`, one `###` section per heading in the listed order,
and deletes the fragments. Running it again changes nothing. Reword the lines in the section where needed and commit the
result. The `Changelog` check refuses a new release section that leaves fragments or Unreleased lines behind. The
release workflow refuses a tag whose section is missing or has no lines, before it builds anything, and publishes the
section as the release notes; a prerelease with no section of its own takes the Unreleased lines and the fragments.

## Commits

One meaning per commit, in the imperative: `fix(web): ...`, `feat(host): ...`, `test(relay): ...`. Say why in the body
when the reason is not obvious from the diff, and keep generated files in the commit that changes them.
