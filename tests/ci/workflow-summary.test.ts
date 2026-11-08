import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A "Workflow summary" step runs `if: always()` and only writes a table, so it must never be the step that fails a job.
// v0.1.5's six desktop jobs built, signed and uploaded every file, then failed here: #924 put the update feed in a
// folder under out/, and the listing loop's `[ -f "$file" ] && echo` returned 1 for that last entry.

type Step = { name?: string; run?: string };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const ROOT = join(import.meta.dir, "..", "..");
const WORKFLOWS = ["release.yml", "render-bench.yml"];

const summarySteps = WORKFLOWS.flatMap((file) => {
  const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", file), "utf8")) as Workflow;
  return Object.entries(workflow.jobs).flatMap(([job, { steps = [] }]) =>
    steps
      .filter((step) => step.name === "Workflow summary" && step.run !== undefined)
      // Expressions are filled in by the runner before bash sees the script; any word stands in for them here.
      .map((step) => ({ id: `${file} ${job}`, script: (step.run ?? "").replace(/\$\{\{[^}]*\}\}/g, "x") })),
  );
});

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** Runs a step's script as the runner does (`bash --noprofile --norc -e -o pipefail`) and returns its exit code and summary. */
function runStep(script: string, populate: (temp: string) => void): { code: number; summary: string } {
  const temp = mkdtempSync(join(tmpdir(), "workflow-summary-"));
  dirs.push(temp);
  populate(temp);
  const summary = join(temp, "summary.md");
  writeFileSync(summary, "");
  const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
    cwd: temp,
    env: { PATH: process.env["PATH"] ?? "", RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary, VERSION: "0.1.5" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, summary: readFileSync(summary, "utf8") };
}

/** What a desktop job leaves in out/: the installers, the standalone host and the runner's update feed in its folder. */
function desktopOut(temp: string): void {
  mkdirSync(join(temp, "out", "feed-mac-arm64"), { recursive: true });
  writeFileSync(join(temp, "out", "Doriterm-0.1.5-arm64.dmg"), "dmg");
  writeFileSync(join(temp, "out", "doriface-host-mac-arm64"), "host");
  writeFileSync(join(temp, "out", "feed-mac-arm64", "latest-mac.yml"), "version: 0.1.5\n");
}

test("the release and render bench workflows have summary steps to check", () => {
  expect(summarySteps.map((step) => step.id)).toEqual(
    expect.arrayContaining(["release.yml desktop", "release.yml release", "render-bench.yml bench"]),
  );
});

for (const { id, script } of summarySteps) {
  test(`${id}: the summary step exits 0 with nothing collected and with a desktop job's files`, () => {
    expect({ id, code: runStep(script, () => {}).code }).toEqual({ id, code: 0 });
    expect({ id, code: runStep(script, desktopOut).code }).toEqual({ id, code: 0 });
  });
}

test("the desktop summary lists every collected file, the update feed in its folder included", () => {
  const desktop = summarySteps.find((step) => step.id === "release.yml desktop");
  const { code, summary } = runStep(desktop?.script ?? "exit 1", desktopOut);
  expect(code).toBe(0);
  expect(summary).toContain("- `Doriterm-0.1.5-arm64.dmg` (3 bytes)");
  expect(summary).toContain("- `doriface-host-mac-arm64` (4 bytes)");
  expect(summary).toContain("- `feed-mac-arm64/latest-mac.yml` (15 bytes)");
  expect(summary).not.toContain("- `feed-mac-arm64` (");
});
