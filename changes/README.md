# Changelog fragments

A pull request that changes what users get records it in `unreleased/<pr-number>.md` instead of `CHANGELOG.md`
(CONTRIBUTING.md, "Changelog"). Before the pull request has a number, the file may be named for the branch, in lowercase
with dashes (`fix-paste.md`); rename it once the number exists.

## Format

```md
### Terminal

- What changed for users, in plain words. (#1234)
- A second change in the same section, its text long enough to go on
  over a line indented two spaces. (#1234)

### Settings

- A change in another section. (#1234)
```

- Only `### <Section>` headings, `- ` lines, continuation lines indented two spaces, and blank lines. Every heading has
  at least one line, and every line sits under a heading.
- The sections are `CANONICAL_HEADINGS` in `.github/scripts/changelog-fragments.ts`; another spelling of one, in any
  case or by a listed alias, is written under the listed name. A name outside the list is kept as written and goes after
  the listed ones.
- The `Changelog` check refuses a fragment that does not fit this format, so the release can always place it.

## Release

`bun .github/scripts/changelog-assemble.ts` writes the `## Unreleased` lines and every fragment into the new version
section of `CHANGELOG.md`, grouped by section, drops a line that is already there, and deletes the fragments.
