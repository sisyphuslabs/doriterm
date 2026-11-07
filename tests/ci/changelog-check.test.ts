import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string> };
type Workflow = {
  on: { pull_request?: { types?: string[] } };
  permissions?: Record<string, string>;
  jobs: Record<string, { name?: string; steps: Step[] }>;
};

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPTS = join(ROOT, ".github", "scripts");
// The check and the fragment rules it imports.
const SCRIPT_FILES = ["changelog-check.ts", "changelog-fragments.ts"];

// A repository of the test's own, with no global or system git config, so no hook or setting of the machine leaks in.
const GIT_ENV = {
  PATH: process.env["PATH"] ?? "",
  HOME: tmpdir(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function git(dir: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: dir, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

const BASE_CHANGELOG =
  "# Changelog\n\n## Unreleased\n\n### Terminals\n\n- Already there. (#1)\n\n## v1.0.0\n\n- First. (#0)\n";

/** A repository whose base commit holds `atBase` too, then one commit with `change` written and `remove` deleted. */
async function repo(
  change: Record<string, string>,
  { atBase = {}, remove = [] }: { atBase?: Record<string, string>; remove?: string[] } = {},
): Promise<{ dir: string; base: string }> {
  const dir = mkdtempSync(join(tmpdir(), "changelog-check-"));
  dirs.push(dir);
  await git(dir, "init", "-q", "-b", "dev");
  write(dir, { "CHANGELOG.md": BASE_CHANGELOG, "apps/web/src/app.ts": "export {};\n", "README.md": "x\n", ...atBase });
  mkdirSync(join(dir, ".github", "scripts"), { recursive: true });
  for (const name of SCRIPT_FILES) copyFileSync(join(SCRIPTS, name), join(dir, ".github", "scripts", name));
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "base");
  const base = await git(dir, "rev-parse", "HEAD");
  write(dir, change);
  for (const path of remove) rmSync(join(dir, path));
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "change");
  return { dir, base };
}

async function check(dir: string, base: string, labels: string[] = []): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, join(dir, ".github", "scripts", "changelog-check.ts"), base], {
    cwd: dir,
    env: { ...GIT_ENV, PR_LABELS: JSON.stringify(labels) },
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

test("a user-facing change with no Unreleased line fails, naming the paths", async () => {
  const { dir, base } = await repo({ "apps/web/src/app.ts": "export const a = 1;\n" });
  const result = await check(dir, base);
  expect(result.code).toBe(1);
  expect(result.out).toContain("apps/web/src/app.ts");
  expect(result.out).toContain("no-changelog");
});

test("a user-facing change with a new Unreleased line passes", async () => {
  const { dir, base } = await repo({
    "apps/web/src/app.ts": "export const a = 1;\n",
    "CHANGELOG.md": BASE_CHANGELOG.replace("- Already there. (#1)\n", "- Already there. (#1)\n- New for users. (#2)\n"),
  });
  expect((await check(dir, base)).code).toBe(0);
});

test("a line added under a released section does not count as an Unreleased line", async () => {
  const { dir, base } = await repo({
    "packages/ui/src/button.tsx": "export {};\n",
    "CHANGELOG.md": BASE_CHANGELOG.replace("- First. (#0)\n", "- First. (#0)\n- Sneaked in. (#2)\n"),
  });
  expect((await check(dir, base)).code).toBe(1);
});

test("a Playwright config is test configuration, so it needs no changelog line", async () => {
  const { dir, base } = await repo({
    "apps/web/playwright.config.ts": "export default {};\n",
    "apps/web/playwright.config.mjs": "export default {};\n",
  });
  expect((await check(dir, base)).code).toBe(0);
});

test("a Playwright config called something else is still user-facing", async () => {
  const { dir, base } = await repo({ "apps/web/playwright.helpers.ts": "export {};\n" });
  expect((await check(dir, base)).code).toBe(1);
});

test("the no-changelog label exempts an internal change", async () => {
  const { dir, base } = await repo({ "apps/web/src/app.ts": "export const a = 1;\n" });
  expect((await check(dir, base, ["review-queued", "no-changelog"])).code).toBe(0);
});

test("a path git would quote, such as one with Hangul in it, still counts as user-facing", async () => {
  const { dir, base } = await repo({ "apps/web/src/한글.ts": "export {};\n" });
  const result = await check(dir, base);
  expect(result.code).toBe(1);
  expect(result.out).toContain("apps/web/src/한글.ts");
});

test("a file moved out of the app into testing/ counts by the path it left", async () => {
  const { dir, base } = await repo({ "README.md": "z\n" });
  mkdirSync(join(dir, "apps", "web", "src", "testing"));
  await git(dir, "mv", "apps/web/src/app.ts", "apps/web/src/testing/app.ts");
  await git(dir, "commit", "-q", "-m", "move");
  const result = await check(dir, base);
  expect(result.code).toBe(1);
  expect(result.out).toContain("apps/web/src/app.ts");
});

test("tests, e2e specs, fixtures, docs and CI files need no line", async () => {
  const { dir, base } = await repo({
    "apps/web/src/app.test.ts": "x\n",
    "apps/web/e2e/tabs.e2e.ts": "x\n",
    "apps/host/src/testing/fake.ts": "x\n",
    "packages/mesh/test/fixtures/a.json": "{}\n",
    "packages/ui/showcase/data.ts": "x\n",
    "packages/ui/README.md": "x\n",
    "tests/ci/a.test.ts": "x\n",
    ".github/workflows/ci.yml": "x\n",
    "docs/a.md": "x\n",
    "README.md": "y\n",
  });
  const result = await check(dir, base);
  expect(result).toEqual({ code: 0, out: expect.stringContaining("no user-facing") });
});

test("a release pull request that moves Unreleased into a new version section passes", async () => {
  const { dir, base } = await repo({
    "apps/desktop/package.json": '{ "version": "1.1.0" }\n',
    "CHANGELOG.md": BASE_CHANGELOG.replace(
      "## Unreleased\n\n### Terminals\n\n- Already there. (#1)\n",
      "## Unreleased\n\n## v1.1.0 - 2026-11-06\n\n### Terminals\n\n- Already there. (#1)\n",
    ),
  });
  expect((await check(dir, base)).code).toBe(0);
});

test("an empty release heading does not stand in for an Unreleased line", async () => {
  const { dir, base } = await repo({
    "apps/web/src/app.ts": "export const a = 1;\n",
    "CHANGELOG.md": BASE_CHANGELOG.replace("## v1.0.0\n", "## v9.9.9\n\n## v1.0.0\n"),
  });
  const result = await check(dir, base);
  expect(result.code).toBe(1);
  expect(result.out).toContain("v9.9.9");
});

test("a release section whose version apps/desktop/package.json does not set is not a release", async () => {
  const { dir, base } = await repo({
    "apps/web/src/app.ts": "export const a = 1;\n",
    "CHANGELOG.md": BASE_CHANGELOG.replace(
      "## Unreleased\n\n### Terminals\n\n- Already there. (#1)\n",
      "## Unreleased\n\n## v1.1.0 - 2026-11-06\n\n### Terminals\n\n- Already there. (#1)\n",
    ),
  });
  const result = await check(dir, base);
  expect(result.code).toBe(1);
  expect(result.out).toContain("apps/desktop/package.json");
});

test("a release section that leaves Unreleased as it was is not a release", async () => {
  const { dir, base } = await repo({
    "apps/desktop/package.json": '{ "version": "1.1.0" }\n',
    "apps/web/src/app.ts": "export const a = 1;\n",
    "CHANGELOG.md": BASE_CHANGELOG.replace("## v1.0.0\n", "## v1.1.0\n\n- Written here instead. (#2)\n\n## v1.0.0\n"),
  });
  const result = await check(dir, base);
  expect(result.code).toBe(1);
  expect(result.out).toContain("Already there");
});

const FRAGMENT = "### Terminals\n\n- New for users. (#2)\n";
const FRAGMENT_3 = "### Terminals\n\n- From a fragment. (#3)\n";
const RELEASED = BASE_CHANGELOG.replace(
  "## Unreleased\n\n### Terminals\n\n- Already there. (#1)\n",
  "## Unreleased\n\n## v1.1.0 - 2026-11-08\n\n### Terminals\n\n- Already there. (#1)\n- From a fragment. (#3)\n",
);

test("a user-facing change with a fragment in changes/unreleased passes", async () => {
  const { dir, base } = await repo({
    "apps/web/src/app.ts": "export const a = 1;\n",
    "changes/unreleased/2.md": FRAGMENT,
  });
  const result = await check(dir, base);
  expect(result.code).toBe(0);
  expect(result.out).toContain("changes/unreleased/2.md");
});

test("a fragment the release cannot place fails, naming the file and the line, even with the label", async () => {
  const { dir, base } = await repo({
    "apps/web/src/app.ts": "export const a = 1;\n",
    "changes/unreleased/2.md": "- No heading above this line. (#2)\n",
  });
  const results = await Promise.all([[], ["no-changelog"]].map((labels) => check(dir, base, labels)));
  for (const result of results) {
    expect(result.code).toBe(1);
    expect(result.out).toContain("changes/unreleased/2.md line 1");
  }
});

test("a fragment that is not named <pr-number>.md or a lowercase branch slug fails", async () => {
  const { dir, base } = await repo({
    "apps/web/src/app.ts": "export const a = 1;\n",
    "changes/unreleased/My Fix.md": FRAGMENT,
  });
  const result = await check(dir, base);
  expect(result.code).toBe(1);
  expect(result.out).toContain("<pr-number>.md");
});

test("a release pull request that writes the fragments into its section and deletes them passes", async () => {
  const { dir, base } = await repo(
    { "apps/desktop/package.json": '{ "version": "1.1.0" }\n', "CHANGELOG.md": RELEASED },
    {
      atBase: { "apps/desktop/package.json": '{ "version": "1.0.0" }\n', "changes/unreleased/3.md": FRAGMENT_3 },
      remove: ["changes/unreleased/3.md"],
    },
  );
  expect((await check(dir, base)).code).toBe(0);
});

test("a release pull request that leaves fragments behind is not a release", async () => {
  const { dir, base } = await repo(
    { "apps/desktop/package.json": '{ "version": "1.1.0" }\n', "CHANGELOG.md": RELEASED },
    { atBase: { "apps/desktop/package.json": '{ "version": "1.0.0" }\n', "changes/unreleased/3.md": FRAGMENT_3 } },
  );
  const result = await check(dir, base);
  expect(result.code).toBe(1);
  expect(result.out).toContain("changes/unreleased/3.md");
  expect(result.out).toContain("changelog-assemble.ts");
});

test("the Changelog workflow runs the check on every pull request event a label can change", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(ROOT, ".github", "workflows", "changelog.yml"), "utf8"),
  ) as Workflow;
  expect(workflow.on.pull_request?.types).toEqual(
    expect.arrayContaining(["opened", "synchronize", "reopened", "labeled", "unlabeled"]),
  );
  expect(workflow.permissions).toEqual({ contents: "read" });
  const job = workflow.jobs["changelog"];
  expect(job?.name).toBe("Changelog");
  const step = job?.steps.find((candidate) => candidate.run?.includes("changelog-check.ts"));
  expect(step?.run).toBe('bun .github/scripts/changelog-check.ts "$BASE_SHA"');
  expect(step?.env?.["PR_LABELS"]).toContain("toJSON(github.event.pull_request.labels.*.name)");
});
