import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = join(import.meta.dir, "..", "..", ".github", "workflows");

interface Step {
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly "timeout-minutes"?: number;
}

interface Workflow {
  readonly jobs: Record<string, { readonly "runs-on"?: string; readonly steps?: readonly Step[] }>;
}

/** A step on an Ubuntu runner that makes apt download: Playwright's system packages, or the contributor guide that does. */
interface AptStep {
  readonly where: string;
  readonly installsDeps: boolean;
  readonly bounded: boolean;
  readonly timeout: number | undefined;
}

const BOUNDS = /apt-bounds\.sh|playwright-linux-deps\.sh/;

function aptSteps(file: string): AptStep[] {
  const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;
  return Object.entries(workflow.jobs).flatMap(([job, { "runs-on": runsOn, steps = [] }]) => {
    if (typeof runsOn !== "string" || !runsOn.startsWith("ubuntu")) return [];
    return steps.flatMap((step, index) => {
      const run = step.run ?? "";
      const installsDeps = /--with-deps|install-deps(?! --dry-run)/.test(run);
      if (!installsDeps && !run.includes("tests/ci/from-zero.ts")) return [];
      const earlier = steps.slice(0, index).some((before) => BOUNDS.test(before.run ?? ""));
      return [
        {
          where: `${file} ${job} "${step.name ?? run.slice(0, 40)}"`,
          installsDeps,
          bounded: earlier || BOUNDS.test(run),
          timeout: step["timeout-minutes"],
        },
      ];
    });
  });
}

const steps = readdirSync(WORKFLOWS)
  .filter((file) => file.endsWith(".yml"))
  .flatMap(aptSteps);

// doriterm#914: apt retries an unreachable mirror for as long as it is allowed to, and the job's limit was the only bound.
test("every Linux step whose apt downloads runs with apt's acquire timeouts set", () => {
  expect(steps.length).toBeGreaterThan(0);
  expect(steps.filter((step) => !step.bounded).map((step) => step.where)).toEqual([]);
});

test("every step that installs Playwright's system packages has a time limit of its own", () => {
  const unbounded = steps.filter((step) => step.installsDeps && (step.timeout === undefined || step.timeout > 25));
  expect(unbounded.map((step) => `${step.where}: ${String(step.timeout)}`)).toEqual([]);
});
