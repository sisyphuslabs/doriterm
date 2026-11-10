import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Step = { name?: string; run?: string; uses?: string };
type Job = { needs?: string | string[]; if?: string; steps: Step[] };
type Workflow = { jobs: Record<string, Job> };

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, ".github", "scripts", "release-notes.ts");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of release-notes.ts next to a CHANGELOG.md of the test's own, laid out as in the repository. */
function checkout(changelog: string, fragments: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".github", "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, ".github", "scripts", "release-notes.ts"));
  copyFileSync(
    join(ROOT, ".github", "scripts", "changelog-fragments.ts"),
    join(dir, ".github", "scripts", "changelog-fragments.ts"),
  );
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  if (Object.keys(fragments).length > 0) mkdirSync(join(dir, "changes", "unreleased"), { recursive: true });
  for (const [name, text] of Object.entries(fragments)) writeFileSync(join(dir, "changes", "unreleased", name), text);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "Doriterm-1.2.0-x86_64.AppImage"), "");
  return dir;
}

async function run(dir: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, join(dir, ".github", "scripts", "release-notes.ts"), ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

const CHANGELOG = `# Changelog

## Unreleased

### Terminals

- Something coming. (#9)

## v1.2.0 - 2026-11-06

### Terminals

- A thing users see. (#7)

## v1.1.0 - 2026-11-05

### Terminals

## v1.0.0

- First release. (#1)
`;

test("the notes carry the version's own CHANGELOG section", async () => {
  const dir = checkout(CHANGELOG);
  const { code, out } = await run(dir, "1.2.0", "assets");
  expect(code).toBe(0);
  expect(out).toContain("- A thing users see. (#7)");
  expect(out).not.toContain("Something coming");
  expect(out).toContain("Doriterm-1.2.0-x86_64.AppImage");
});

test("the downloads list the zip and the installer but not their .blockmap or the update feed", async () => {
  const dir = checkout(CHANGELOG);
  for (const name of [
    "Doriterm-1.2.0-arm64-mac.zip",
    "Doriterm-1.2.0-arm64-mac.zip.blockmap",
    "Doriterm-1.2.0-x64-setup.exe",
    "Doriterm-1.2.0-x64-setup.exe.blockmap",
    "latest-mac.yml",
  ]) {
    writeFileSync(join(dir, "assets", name), "");
  }
  const { code, out } = await run(dir, "1.2.0", "assets");
  expect(code).toBe(0);
  expect(out).toContain("- **macOS, Apple silicon:** `Doriterm-1.2.0-arm64-mac.zip`\n");
  expect(out).toContain("- **Windows x64:** `Doriterm-1.2.0-x64-setup.exe`\n");
  expect(out).not.toContain(".blockmap");
});

test("a release with no CHANGELOG section is refused, in --check and when writing the notes", async () => {
  const dir = checkout(CHANGELOG);
  const calls = [
    ["--check", "1.3.0"],
    ["1.3.0", "assets"],
  ];
  const results = await Promise.all(calls.map(async (args) => Object.assign(await run(dir, ...args), { args })));
  for (const { args, code, out, err } of results) {
    expect({ args, code, out }).toEqual({ args, code: 1, out: "" });
    expect(err).toContain("## v1.3.0");
  }
});

test("a section with only subheadings is empty, and is refused", async () => {
  const dir = checkout(CHANGELOG);
  const { code, err } = await run(dir, "--check", "1.1.0");
  expect(code).toBe(1);
  expect(err).toContain("empty");
});

test("--check passes a release whose section has lines", async () => {
  const dir = checkout(CHANGELOG);
  expect((await run(dir, "--check", "1.0.0")).code).toBe(0);
  expect((await run(dir, "--check", "1.2.0")).code).toBe(0);
});

test("a prerelease takes its version's section, else Unreleased, and is refused when both are empty", async () => {
  const dir = checkout(CHANGELOG);
  const rc = await run(dir, "1.2.0-rc.1", "assets");
  expect(rc.code).toBe(0);
  expect(rc.out).toContain("A thing users see");

  const next = await run(dir, "1.3.0-rc.1", "assets");
  expect(next.code).toBe(0);
  expect(next.out).toContain("Something coming");

  const bare = checkout("# Changelog\n\n## Unreleased\n\n### Terminals\n");
  expect((await run(bare, "--check", "1.3.0-rc.1")).code).toBe(1);
});

test("a prerelease's Unreleased notes carry the fragments too, under their headings", async () => {
  const dir = checkout(CHANGELOG, {
    "12.md": "### terminals\n\n- From a fragment. (#12)\n",
  });
  const { code, out } = await run(dir, "1.3.0-rc.1", "assets");
  expect(code).toBe(0);
  expect(out).toContain("### Terminal\n\n- Something coming. (#9)\n- From a fragment. (#12)\n");
});

test("a malformed pending fragment fails only the notes that read the fragments (#1330)", async () => {
  const dir = checkout(CHANGELOG, { "13.md": "- No heading. (#13)\n" });
  const own = await Promise.all([
    run(dir, "--check", "1.2.0"),
    run(dir, "1.2.0", "assets"),
    run(dir, "--check", "1.2.0-rc.1"),
    run(dir, "--check", "1.0.0"),
  ]);
  for (const { code, err } of own) expect({ code, err }).toEqual({ code: 0, err: "" });
  const pending = await run(dir, "--check", "1.3.0-rc.1");
  expect(pending.code).toBe(1);
  expect(pending.err).toContain("changes/unreleased/13.md line 1");
});

test("the release workflow checks the CHANGELOG section before any build", () => {
  const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8")) as Workflow;
  const version = workflow.jobs["version"];
  if (version === undefined) throw new Error("release.yml has no version job");
  const runs = version.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));
  expect(runs).toContain('bun .github/scripts/release-notes.ts --check "$VERSION"');
  // Every build waits on the version job, so a missing section stops the run before an hour of builds.
  for (const id of ["desktop", "web"]) expect(workflow.jobs[id]?.needs).toBe("version");
});

/**
 * `--check` in `dir` for v0.1.0-v0.1.5 and every vX.Y.Z tag in HEAD's history. A release tagged on a commit the
 * tree under test does not contain is not checked, so a branch's result does not change when dev is tagged.
 * v0.1.0-v0.1.2 are listed by name as before. v0.1.3-v0.1.5 are too: they are tagged on release-PR heads that were
 * squash-merged, so no branch off dev has those tags in its history.
 */
async function checkReleasedVersions(dir: string): Promise<{ tag: string; code: number; err: string }[]> {
  const proc = Bun.spawn(["git", "tag", "--merged", "HEAD", "--list", "v*"], { cwd: dir, stdout: "pipe" });
  const tags = (await new Response(proc.stdout).text()).split("\n").filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  const versions = [...new Set(["v0.1.0", "v0.1.1", "v0.1.2", "v0.1.3", "v0.1.4", "v0.1.5", ...tags])];
  return Promise.all(
    versions.map(async (tag) => {
      const { code, err } = await run(dir, "--check", tag.slice(1));
      return { tag, code, err };
    }),
  );
}

async function git(dir: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(
    [
      "git",
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: dir, stdout: "ignore", stderr: "pipe" },
  );
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
}

const RELEASED = `# Changelog

## v1.0.0

- First release. (#1)
${[5, 4, 3, 2, 1, 0].map((patch) => `\n## v0.1.${patch}\n\n- A change. (#${patch + 2})\n`).join("")}`;

/** A checkout of RELEASED with v1.0.0 tagged on HEAD and v1.1.0 tagged on a branch HEAD does not contain. */
async function taggedCheckout(): Promise<string> {
  const dir = checkout(RELEASED);
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "--no-verify", "-m", "v1.0.0");
  await git(dir, "tag", "v1.0.0");
  await git(dir, "checkout", "-q", "-b", "release");
  await git(dir, "commit", "-q", "--no-verify", "--allow-empty", "-m", "v1.1.0");
  await git(dir, "tag", "v1.1.0");
  await git(dir, "checkout", "-q", "main");
  return dir;
}

test("a tag outside HEAD's history is not a released version of the tree under test", async () => {
  const results = await checkReleasedVersions(await taggedCheckout());
  expect(results.map(({ tag }) => tag)).toEqual(["v0.1.0", "v0.1.1", "v0.1.2", "v0.1.3", "v0.1.4", "v0.1.5", "v1.0.0"]);
  for (const { tag, code, err } of results) expect({ tag, code, err }).toEqual({ tag, code: 0, err: "" });
});

test("a tag in HEAD's history with no CHANGELOG section fails the check", async () => {
  const dir = await taggedCheckout();
  await git(dir, "merge", "-q", "--ff-only", "release");
  const missing = (await checkReleasedVersions(dir)).find(({ tag }) => tag === "v1.1.0");
  expect(missing?.code).toBe(1);
  expect(missing?.err).toContain("## v1.1.0");
});

test("CHANGELOG.md has a section with lines for every released version", async () => {
  for (const { tag, code, err } of await checkReleasedVersions(ROOT)) {
    expect({ tag, code, err }).toEqual({ tag, code: 0, err: "" });
  }
});
