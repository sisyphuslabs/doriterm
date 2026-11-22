import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleRelease,
  canonicalHeading,
  FRAGMENT_DIR,
  parseFragment,
  pendingNotes,
  readFragments,
  type Fragment,
} from "../../.github/scripts/changelog-fragments.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPTS = join(ROOT, ".github", "scripts");
const FIXTURE = join(import.meta.dir, "fixtures", "changelog-assemble");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const input = (): string => readFileSync(join(FIXTURE, "CHANGELOG.md"), "utf8");
const expected = (): string => readFileSync(join(FIXTURE, "expected.md"), "utf8");
const fixtureFragments = (): Fragment[] => readFragments(join(FIXTURE, "fragments"));

test("the release section holds Unreleased and every fragment, grouped in the CHANGELOG's heading order", () => {
  const result = assembleRelease({
    changelog: input(),
    fragments: fixtureFragments(),
    version: "1.3.0",
    date: "2026-11-08",
  });
  expect(result).toEqual({ ok: true, changelog: expected(), changed: true, lines: 7 });
});

test("a second run, with the fragments gone, changes nothing", () => {
  const result = assembleRelease({ changelog: expected(), fragments: [], version: "1.3.0", date: "2026-11-09" });
  expect(result).toEqual({ ok: true, changelog: expected(), changed: false, lines: 0 });
});

test("a fragment that lands after the section was written joins it under its heading", () => {
  const late: Fragment = { name: "1400.md", text: "### settings\n\n- Late. (#1400)\n" };
  const result = assembleRelease({ changelog: expected(), fragments: [late], version: "1.3.0", date: "2026-11-09" });
  expect(result).toEqual({
    ok: true,
    changelog: expected().replace("- A settings fragment. (#98)\n", "- A settings fragment. (#98)\n- Late. (#1400)\n"),
    changed: true,
    lines: 1,
  });
});

test("with no lines anywhere and no section for the version yet, there is nothing to release", () => {
  const result = assembleRelease({ changelog: expected(), fragments: [], version: "1.4.0", date: "2026-11-09" });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).toContain("v1.4.0");
});

test("only an X.Y.Z version gets a section", () => {
  for (const version of ["1.3.0-rc.1", "v1.3.0", "1.3"]) {
    const result = assembleRelease({ changelog: input(), fragments: [], version, date: "2026-11-08" });
    expect(result.ok).toBe(false);
  }
});

test("a fragment in a bad shape is refused, naming the file and the line", () => {
  const cases: [Fragment, string][] = [
    [{ name: "1.md", text: "- No heading. (#1)\n" }, "changes/unreleased/1.md line 1"],
    [{ name: "2.md", text: "### Terminal\n" }, "### Terminal has no lines"],
    [{ name: "3.md", text: "## v9.9.9\n\n- A line. (#3)\n" }, "changes/unreleased/3.md line 1"],
    [{ name: "4.md", text: "\n" }, "changes/unreleased/4.md is empty"],
    [{ name: "5.md", text: "### Terminal\n\nSome prose. (#5)\n" }, "changes/unreleased/5.md line 3"],
    [{ name: "Bad Name.md", text: "### Terminal\n\n- A line. (#6)\n" }, "<pr-number>.md"],
    [{ name: "7.txt", text: "### Terminal\n\n- A line. (#7)\n" }, "<pr-number>.md"],
    [{ name: "8.md", text: "###  \n- A line. (#8)\n" }, "changes/unreleased/8.md line 1"],
    [{ name: "9.md", text: "###\n\n- A line. (#9)\n" }, "changes/unreleased/9.md line 1"],
  ];
  for (const [fragment, problem] of cases) {
    const parsed = parseFragment(fragment);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).toContain(problem);
    const assembled = assembleRelease({
      changelog: input(),
      fragments: [fragment],
      version: "1.3.0",
      date: "2026-11-08",
    });
    expect(assembled.ok).toBe(false);
    expect(JSON.stringify(assembled)).toContain(problem);
  }
});

test("a prerelease's notes are Unreleased and the fragments, grouped the same way", () => {
  const result = pendingNotes(input(), fixtureFragments());
  const section = expected().split("## v1.3.0 - 2026-11-08\n\n")[1]?.split("\n## v1.2.0")[0]?.trim();
  expect(result).toEqual({ ok: true, notes: section ?? "missing" });
});

test("a heading open pull requests wrote outside the list goes under its release section (#1324)", () => {
  const headings = [
    "Host setup",
    "First run",
    "Connection",
    "From the phone",
    "Machines",
    "Adding a machine",
    "Keys, as herdr-app binds them",
  ];
  expect(headings.map(canonicalHeading)).toEqual([
    "Host install",
    "Workspace",
    "Connection and offline wording",
    "Phone",
    "Machine mesh",
    "Joining a mesh",
    "Keys",
  ]);
});

test("a bare Host heading is kept as written, not filed under Host install (#1326)", () => {
  expect(canonicalHeading("Host")).toBe("Host");
  expect(canonicalHeading("host")).toBe("host");
});

test("a section that already exists below a newer one gains the lines where it stands (#1273)", () => {
  const changelog =
    "# Changelog\n\n## Unreleased\n\n## v0.1.5 - 2026-11-07\n\n- Five. (#5)\n\n" +
    "## v0.1.4 - 2026-11-06\n\n### Terminal\n\n- Four. (#4)\n\n## v0.1.3\n\n- Three. (#3)\n";
  const late: Fragment = { name: "6.md", text: "### Terminal\n\n- Late. (#6)\n" };
  const result = assembleRelease({ changelog, fragments: [late], version: "0.1.4", date: "2026-11-09" });
  expect(result).toEqual({
    ok: true,
    changelog: changelog.replace("- Four. (#4)\n", "- Four. (#4)\n- Late. (#6)\n"),
    changed: true,
    lines: 1,
  });
});

test("Keys comes right after Workspace in a release", () => {
  const fragments: Fragment[] = [
    { name: "1.md", text: "### Machine mesh\n\n- Mesh. (#1)\n" },
    { name: "2.md", text: "### Keys, as herdr-app binds them\n\n- Keys. (#2)\n" },
    { name: "3.md", text: "### Workspace\n\n- Workspace. (#3)\n" },
  ];
  expect(pendingNotes("## Unreleased\n", fragments)).toEqual({
    ok: true,
    notes: "### Workspace\n\n- Workspace. (#3)\n\n### Keys\n\n- Keys. (#2)\n\n### Machine mesh\n\n- Mesh. (#1)",
  });
});

test("every fragment in this repository has the shape the release can place", () => {
  for (const fragment of readFragments(join(ROOT, FRAGMENT_DIR))) {
    expect(parseFragment(fragment)).toMatchObject({ ok: true });
  }
});

/** A checkout laid out as the repository: the two scripts, CHANGELOG.md, the desktop version and the fragments. */
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "changelog-assemble-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".github", "scripts"), { recursive: true });
  for (const name of ["changelog-assemble.ts", "changelog-fragments.ts"]) {
    copyFileSync(join(SCRIPTS, name), join(dir, ".github", "scripts", name));
  }
  copyFileSync(join(FIXTURE, "CHANGELOG.md"), join(dir, "CHANGELOG.md"));
  mkdirSync(join(dir, "apps", "desktop"), { recursive: true });
  writeFileSync(join(dir, "apps", "desktop", "package.json"), '{ "version": "1.3.0" }\n');
  cpSync(join(FIXTURE, "fragments"), join(dir, FRAGMENT_DIR), { recursive: true });
  return dir;
}

async function assemble(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, join(dir, ".github", "scripts", "changelog-assemble.ts"), ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

test("the CLI writes the section for apps/desktop/package.json's version, deletes the fragments, and a rerun is a no-op", async () => {
  const dir = checkout();
  const first = await assemble(dir, "--date", "2026-11-08");
  expect(first.code).toBe(0);
  expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe(expected());
  expect(existsSync(join(dir, FRAGMENT_DIR)) ? readdirSync(join(dir, FRAGMENT_DIR)) : []).toEqual([]);
  const second = await assemble(dir, "1.3.0", "--date", "2026-11-09");
  expect(second.code).toBe(0);
  expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe(expected());
});

test("the CLI takes a version given without --date over apps/desktop/package.json's, which may be a prerelease (#2471)", async () => {
  const dir = checkout();
  writeFileSync(join(dir, "apps", "desktop", "package.json"), '{ "version": "1.3.0-beta.1" }\n');
  const result = await assemble(dir, "1.3.0");
  expect(result.out).not.toContain("is not a release version");
  expect(result.code).toBe(0);
  expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toContain("## v1.3.0");
});

test("the CLI writes nothing and deletes nothing when a fragment is refused", async () => {
  const dir = checkout();
  writeFileSync(join(dir, FRAGMENT_DIR, "99.md"), "- No heading. (#99)\n");
  const result = await assemble(dir, "--date", "2026-11-08");
  expect(result.code).toBe(1);
  expect(result.out).toContain("changes/unreleased/99.md line 1");
  expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe(input());
  expect(readdirSync(join(dir, FRAGMENT_DIR)).toSorted()).toEqual(["1300.md", "98.md", "99.md", "tidy-sidebar.md"]);
});
