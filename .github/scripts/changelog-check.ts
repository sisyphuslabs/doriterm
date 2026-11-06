#!/usr/bin/env bun
/**
 * Fails a pull request that changes what users get, a file under apps/ or packages/ that is not a test, an e2e spec, a
 * fixture, a showcase or a Markdown file, unless it adds a line under `## Unreleased` in CHANGELOG.md, adds a new
 * release section (a release pull request), or carries the `no-changelog` label for an internal change.
 *
 * Usage: bun .github/scripts/changelog-check.ts <base sha>
 * Reads the pull request's label names as a JSON array from $PR_LABELS; compares the merge base with HEAD.
 */

const EXEMPT_LABEL = "no-changelog";

const NOT_USER_FACING = [
  /(^|\/)(e2e|tests?|testing|fixtures|__tests__|showcase)\//,
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$/,
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

function unreleasedEntries(changelog: string): Set<string> {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+\[?Unreleased\]?(?:\s|$)/i.test(line));
  if (start === -1) return new Set();
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return new Set(
    (end === -1 ? rest : rest.slice(0, end)).map((line) => line.trim()).filter((line) => line.startsWith("- ")),
  );
}

const releaseHeadings = (changelog: string): Set<string> =>
  new Set(changelog.split(/\r?\n/).flatMap((line) => /^##\s+\[?v?(\d+\.\d+\.\d+[^\]\s]*)/.exec(line)?.[1] ?? []));

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
const changed = (await mustGit("diff", "--name-only", "-z", "--no-renames", mergeBase, "HEAD"))
  .split("\0")
  .filter((path) => path !== "");
const userFacing = changed.filter(isUserFacing);

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
if (newReleases.length > 0) {
  console.log(`Changelog: new release section(s) ${newReleases.map((version) => `v${version}`).join(", ")}.`);
  process.exit(0);
}

const shown =
  userFacing.slice(0, 20).join(", ") + (userFacing.length > 20 ? `, and ${userFacing.length - 20} more` : "");
fail(
  `This pull request changes what users get (${shown}) and adds no line under "## Unreleased" in CHANGELOG.md. ` +
    `Add one line saying what changed for users, with the pull request number, or add the ${EXEMPT_LABEL} label if ` +
    `nothing changes for them (CONTRIBUTING.md, "Changelog").`,
);
