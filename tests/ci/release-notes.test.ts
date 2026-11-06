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
function checkout(changelog: string): string {
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".github", "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, ".github", "scripts", "release-notes.ts"));
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
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

test("the release workflow checks the CHANGELOG section before any build", () => {
  const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8")) as Workflow;
  const version = workflow.jobs["version"];
  if (version === undefined) throw new Error("release.yml has no version job");
  const runs = version.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));
  expect(runs).toContain('bun .github/scripts/release-notes.ts --check "$VERSION"');
  // Every build waits on the version job, so a missing section stops the run before an hour of builds.
  for (const id of ["desktop", "web"]) expect(workflow.jobs[id]?.needs).toBe("version");
});

test("CHANGELOG.md has a section with lines for every released version", async () => {
  const proc = Bun.spawn(["git", "tag", "--list", "v*"], { cwd: ROOT, stdout: "pipe" });
  const tags = (await new Response(proc.stdout).text()).split("\n").filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  const versions = [...new Set(["v0.1.0", "v0.1.1", "v0.1.2", ...tags])];
  const results = await Promise.all(
    versions.map(async (tag) => Object.assign(await run(ROOT, "--check", tag.slice(1)), { tag })),
  );
  for (const { tag, code, err } of results) expect({ tag, code, err }).toEqual({ tag, code: 0, err: "" });
});
