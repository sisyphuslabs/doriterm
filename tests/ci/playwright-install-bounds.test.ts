import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, type Value } from "./gh-expression.ts";

const WORKFLOWS = join(import.meta.dir, "..", "..", ".github", "workflows");

interface Step {
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly "timeout-minutes"?: number;
}

interface Job {
  readonly "runs-on"?: string;
  readonly strategy?: { readonly matrix?: Readonly<Record<string, Value>> };
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly jobs: Record<string, Job>;
}

/** A step on an Ubuntu runner that makes apt download: Playwright's system packages, or the contributor guide that does. */
interface AptStep {
  readonly where: string;
  readonly installsDeps: boolean;
  readonly bounded: boolean;
  readonly timeout: number | undefined;
}

const BOUNDS = /apt-bounds\.sh|playwright-linux-deps\.sh/;

type Combination = Record<string, Value>;

const isCombination = (value: Value): value is Combination =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * GitHub's matrix expansion for the axes and include rows this repository uses: every combination of the axes, without
 * the `exclude` rows, then each `include` row merged into the combinations it does not overwrite, or a combination of
 * its own when it does. A matrix with only include rows has one combination per row.
 */
function expandMatrix(matrix: Readonly<Record<string, Value>>): Combination[] {
  const include = matrix["include"];
  const exclude = matrix["exclude"];
  const axes = Object.keys(matrix).filter((key) => key !== "include" && key !== "exclude");
  let combinations: Combination[] = axes.length === 0 ? [] : [{}];
  for (const key of axes) {
    const values = matrix[key];
    if (!Array.isArray(values)) continue;
    combinations = combinations.flatMap((combination) =>
      values.map((value) => Object.assign({}, combination, { [key]: value })),
    );
  }
  const excluded = Array.isArray(exclude) ? exclude.filter(isCombination) : [];
  combinations = combinations.filter(
    (combination) => !excluded.some((row) => Object.entries(row).every(([key, value]) => combination[key] === value)),
  );
  for (const row of Array.isArray(include) ? include.filter(isCombination) : []) {
    const merged = combinations.filter((combination) =>
      Object.entries(row).every(([key, value]) => !(key in combination) || combination[key] === value),
    );
    if (merged.length === 0) combinations.push({ ...row });
    else for (const combination of merged) Object.assign(combination, row);
  }
  return combinations;
}

/** The labels a job may run on; a matrix expression resolves once per combination. */
function runners(job: Job): string[] {
  const runsOn = job["runs-on"];
  if (typeof runsOn !== "string") return [];
  if (!runsOn.includes("${{")) return [runsOn];
  return expandMatrix(job.strategy?.matrix ?? {}).flatMap((matrix) => {
    const runner = evaluate(runsOn, { contexts: { matrix } });
    return typeof runner === "string" ? [runner] : [];
  });
}

/** The apt-downloading steps of one workflow, considered Linux when any of the job's resolved runners is Ubuntu. */
function aptSteps(workflow: Workflow, file: string): AptStep[] {
  return Object.entries(workflow.jobs).flatMap(([job, definition]) => {
    if (!runners(definition).some((runner) => runner.startsWith("ubuntu"))) return [];
    const steps = definition.steps ?? [];
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
  .flatMap((file) => aptSteps(Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow, file));

// doriterm#914: apt retries an unreachable mirror for as long as it is allowed to, and the job's limit was the only bound.
test("every Linux step whose apt downloads runs with apt's acquire timeouts set", () => {
  expect(steps.length).toBeGreaterThan(0);
  expect(steps.filter((step) => !step.bounded).map((step) => step.where)).toEqual([]);
});

test("every step that installs Playwright's system packages has a time limit of its own", () => {
  const unbounded = steps.filter((step) => step.installsDeps && (step.timeout === undefined || step.timeout > 25));
  expect(unbounded.map((step) => `${step.where}: ${String(step.timeout)}`)).toEqual([]);
});

// doriterm#1214: runs-on was only read as a literal, so a matrix job on Ubuntu escaped both checks above.
test("an unbounded apt step in a matrix job whose runners include Ubuntu is caught", () => {
  const workflow: Workflow = {
    jobs: {
      e2e: {
        "runs-on": "${{ matrix.runner }}",
        strategy: { matrix: { runner: ["ubuntu-24.04", "windows-2025"] } },
        steps: [{ name: "Chromium", run: "bunx playwright install --with-deps chromium" }],
      },
    },
  };
  const found = aptSteps(workflow, "synthetic.yml");
  expect(found.filter((step) => !step.bounded).map((step) => step.where)).toEqual(['synthetic.yml e2e "Chromium"']);
});

test("an Ubuntu runner added by a matrix include row is resolved too", () => {
  const workflow: Workflow = {
    jobs: {
      e2e: {
        "runs-on": "${{ matrix.runner }}",
        strategy: { matrix: { runner: ["windows-2025"], include: [{ runner: "ubuntu-24.04", arch: "x64" }] } },
        steps: [{ name: "Chromium", run: "bunx playwright install --with-deps chromium", "timeout-minutes": 12 }],
      },
    },
  };
  expect(aptSteps(workflow, "synthetic.yml").map((step) => step.where)).toEqual(['synthetic.yml e2e "Chromium"']);
});

test("a matrix of only non-Ubuntu runners is still left out", () => {
  const workflow: Workflow = {
    jobs: {
      client: {
        "runs-on": "${{ matrix.runner }}",
        strategy: { matrix: { runner: ["windows-latest", "macos-15"] } },
        steps: [{ name: "Chromium", run: "bunx playwright install --with-deps chromium", "timeout-minutes": 12 }],
      },
    },
  };
  expect(aptSteps(workflow, "synthetic.yml")).toEqual([]);
});
