import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly "timeout-minutes"?: number;
}
interface Job {
  readonly name?: string;
  readonly "timeout-minutes"?: number;
  readonly steps: readonly Step[];
}

const ci = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "..", "..", ".github", "workflows", "ci.yml"), "utf8"),
) as { jobs: Record<string, Job> };
const job = Object.values(ci.jobs).find((candidate) => candidate.name === "Web e2e");
if (job === undefined) throw new Error("ci.yml has no Web e2e job");
const steps = job.steps;
const step = (match: (step: Step) => boolean, what: string): Step => {
  const found = steps.find(match);
  if (found === undefined) throw new Error(`the Web e2e job has no ${what} step`);
  return found;
};
const playwright = step((s) => s.name === "Playwright e2e against a real hc", "Playwright e2e");
const upload = step((s) => s.uses?.startsWith("actions/upload-artifact@") === true, "upload-artifact");

// The Playwright step took 21.7-27.3 min in passing runs and was cut at 28.9 and 29.4 min by the old 30-min job cap
// (#2382), which cancelled the job during or before the upload and left no readable log.
test("the Playwright step has its own bound with room over the measured runs (#2382)", () => {
  expect(playwright["timeout-minutes"]).toBeGreaterThanOrEqual(40);
});

test("the report upload always runs, on its own bound (#2382)", () => {
  expect(upload.if).toBe("always()");
  expect(upload["timeout-minutes"]).toBeGreaterThan(0);
});

test("the job's budget covers every bounded step at its worst, so a slow test can never cancel the upload (#2382)", () => {
  const bounded = steps.reduce((sum, s) => sum + (s["timeout-minutes"] ?? 0), 0);
  // The unbounded steps (checkout, bun, herdr-core, install, caches) take about a minute together in every measured run.
  expect(job["timeout-minutes"] ?? 360).toBeGreaterThanOrEqual(bounded + 3);
});
