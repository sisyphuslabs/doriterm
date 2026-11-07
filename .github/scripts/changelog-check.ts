#!/usr/bin/env bun
/**
 * Fails a pull request that changes what users get, a file under apps/ or packages/ that is not a test, an e2e spec, a
 * fixture, a showcase or a Markdown file, unless it adds a changelog fragment, changes/unreleased/<pr-number>.md
 * (changelog-fragments.ts), adds a line under `## Unreleased` in CHANGELOG.md (accepted while open pull requests
 * convert), is a release pull request, or carries the `no-changelog` label for an internal change. A fragment the release
 * cannot place fails whatever else the pull request does. A release pull request adds a `## vX.Y.Z` section with lines,
 * empties Unreleased into it, deletes every fragment (changelog-assemble.ts does both) and sets that version in
 * apps/desktop/package.json; a new heading that does less is refused, so an empty or hand-made section cannot stand in
 * for a changelog line.
 *
 * Usage: bun .github/scripts/changelog-check.ts <base sha>
 * Reads the pull request's label names as a JSON array from $PR_LABELS; compares the merge base with HEAD.
 */
import { FRAGMENT_DIR, parseFragment } from "./changelog-fragments.ts";

const EXEMPT_LABEL = "no-changelog";

const NOT_USER_FACING = [
  /(^|\/)(e2e|tests?|testing|fixtures|__tests__|showcase)\//,
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$/,
  // Test configuration, not behaviour: a Playwright config decides which engines a spec runs in, and every PR that
  // touches one would otherwise owe a user-facing changelog line.
  /(^|\/)playwright\.config\.[cm]?[jt]s$/,
  /\.md$/,
];

const isUserFacing = (path: string): boolean =>
  /^(apps|packages)\//.test(path) && !NOT_USER_FACING.some((pattern) => pattern.test(path));

async function git(...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "inherit" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, out };
}

async function mustGit(...args: string[]): Promise<string> {
  const { code, out } = await git(...args);
  if (code !== 0) fail(`git ${args.join(" ")} exited ${code}`);
  return out;
}

function fail(message: string): never {
  console.error(`::error title=Changelog::${message}`);
  process.exit(1);
}

/** The `- ` lines of the first `## ` section whose heading matches, up to the next `## ` heading. */
function sectionEntries(changelog: string, isHeading: (line: string) => boolean): string[] {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex(isHeading);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).map((line) => line.trim()).filter((line) => line.startsWith("- "));
}

const unreleasedEntries = (changelog: string): Set<string> =>
  new Set(sectionEntries(changelog, (line) => /^##\s+\[?Unreleased\]?(?:\s|$)/i.test(line)));

const RELEASE_HEADING = /^##\s+\[?v?(\d+\.\d+\.\d+[^\]\s]*)/;

const releaseHeadings = (changelog: string): Set<string> =>
  new Set(changelog.split(/\r?\n/).flatMap((line) => RELEASE_HEADING.exec(line)?.[1] ?? []));

/** The version apps/desktop/package.json declares at a revision, or undefined when the file or its version is absent. */
async function desktopVersion(revision: string): Promise<string | undefined> {
  const shown = await git("show", `${revision}:apps/desktop/package.json`);
  if (shown.code !== 0) return undefined;
  let manifest: unknown;
  try {
    manifest = JSON.parse(shown.out);
  } catch {
    fail(`apps/desktop/package.json at ${revision} is not JSON`);
  }
  const version: unknown =
    typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "version") : undefined;
  return typeof version === "string" ? version : undefined;
}

function labels(): string[] {
  const raw = process.env["PR_LABELS"] ?? "";
  if (raw.trim() === "") return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) fail("PR_LABELS is not a JSON array of label names");
  return parsed.filter((label): label is string => typeof label === "string");
}

const base = Bun.argv[2];
if (base === undefined || base === "") {
  console.error("usage: bun .github/scripts/changelog-check.ts <base sha>");
  process.exit(2);
}

const mergeBase = (await mustGit("merge-base", base, "HEAD")).trim();
// -z keeps a path with non-ASCII characters unquoted; --no-renames lists a moved file under the path it left as well.
const statuses = (await mustGit("diff", "--name-status", "-z", "--no-renames", mergeBase, "HEAD")).split("\0");
const diff = statuses.flatMap((status, index) =>
  index % 2 === 0 && status !== "" ? [{ status, path: statuses[index + 1] ?? "" }] : [],
);
const changed = diff.map(({ path }) => path);
const userFacing = changed.filter(isUserFacing);

const fragmentName = (path: string): string | undefined =>
  path.startsWith(`${FRAGMENT_DIR}/`) ? path.slice(FRAGMENT_DIR.length + 1) : undefined;
const written = diff.filter(({ status, path }) => status !== "D" && fragmentName(path) !== undefined);
const problems = (
  await Promise.all(
    written.map(async ({ path }) => {
      const parsed = parseFragment({ name: fragmentName(path) ?? path, text: await mustGit("show", `HEAD:${path}`) });
      return parsed.ok ? [] : parsed.problems;
    }),
  )
).flat();
if (problems.length > 0) {
  fail(`A changelog fragment cannot go into a release as written (changes/README.md): ${problems.join("; ")}`);
}
const addedFragments = written.filter(({ status }) => status === "A").map(({ path }) => path);

if (userFacing.length === 0) {
  console.log(`Changelog: no user-facing path changed (${changed.length} files), so no line is needed.`);
  process.exit(0);
}
if (labels().includes(EXEMPT_LABEL)) {
  console.log(`Changelog: the ${EXEMPT_LABEL} label marks this change as internal.`);
  process.exit(0);
}

const before = await git("show", `${mergeBase}:CHANGELOG.md`);
const after = await git("show", "HEAD:CHANGELOG.md");
const beforeText = before.code === 0 ? before.out : "";
const afterText = after.code === 0 ? after.out : "";

const known = unreleasedEntries(beforeText);
const added = [...unreleasedEntries(afterText)].filter((entry) => !known.has(entry));
const releasedBefore = releaseHeadings(beforeText);
const newReleases = [...releaseHeadings(afterText)].filter((version) => !releasedBefore.has(version));

if (added.length > 0) {
  console.log(`Changelog: ${added.length} new line(s) under Unreleased:\n${added.join("\n")}`);
  process.exit(0);
}
if (addedFragments.length > 0) {
  console.log(`Changelog: ${addedFragments.length} new fragment(s): ${addedFragments.join(", ")}`);
  process.exit(0);
}
if (newReleases.length > 0) {
  const [versionBefore, versionAfter] = await Promise.all([desktopVersion(mergeBase), desktopVersion("HEAD")]);
  const leftFragments = (await mustGit("ls-tree", "-z", "--name-only", "HEAD", `${FRAGMENT_DIR}/`))
    .split("\0")
    .filter((path) => path !== "");
  const stillUnreleased = unreleasedEntries(afterText);
  const refusals = newReleases.flatMap((version): string[] => {
    const entries = sectionEntries(afterText, (line) => RELEASE_HEADING.exec(line)?.[1] === version);
    const reasons: string[] = [];
    if (entries.length === 0) reasons.push("it has no lines");
    if (versionAfter !== version || versionBefore === version)
      reasons.push(`this pull request does not set version ${version} in apps/desktop/package.json`);
    // The notes are often reworded on the way into the release section, so the lines need not match one for one; what
    // a release always does is empty Unreleased.
    const left = [...known].filter((entry) => stillUnreleased.has(entry));
    if (left.length > 0) reasons.push(`Unreleased still holds ${left.join(" ")}`);
    if (leftFragments.length > 0) {
      reasons.push(
        `${leftFragments.join(", ")} still wait to be written into it (bun .github/scripts/changelog-assemble.ts ${version})`,
      );
    }
    return reasons.length === 0 ? [] : [`v${version}: ${reasons.join("; ")}`];
  });
  if (refusals.length === 0) {
    console.log(`Changelog: release section(s) ${newReleases.map((version) => `v${version}`).join(", ")}.`);
    process.exit(0);
  }
  fail(
    `This pull request adds a release section that is not a release (${refusals.join(" | ")}). A release pull ` +
      `request moves every Unreleased line and fragment into the new section and sets that version in ` +
      `apps/desktop/package.json; any other change adds its own fragment in ${FRAGMENT_DIR}/ or carries the ` +
      `${EXEMPT_LABEL} label.`,
  );
}

const shown =
  userFacing.slice(0, 20).join(", ") + (userFacing.length > 20 ? `, and ${userFacing.length - 20} more` : "");
fail(
  `This pull request changes what users get (${shown}) and adds no changelog fragment. Add ` +
    `${FRAGMENT_DIR}/<pr-number>.md with a "### <Section>" heading and one line saying what changed for users, ` +
    `with the pull request number, or add the ${EXEMPT_LABEL} label if nothing changes for them ` +
    `(CONTRIBUTING.md, "Changelog").`,
);
