import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, type Value } from "./gh-expression.ts";

type Concurrency = { group: string; "cancel-in-progress"?: string | boolean; queue?: string };
type Workflow = { on: { push?: { branches?: string[] }; pull_request?: unknown }; concurrency?: Concurrency };

const DIR = join(import.meta.dir, "..", "..", ".github", "workflows");
const workflows = readdirSync(DIR)
  .filter((file) => file.endsWith(".yml"))
  .map((file) => ({ file, workflow: Bun.YAML.parse(readFileSync(join(DIR, file), "utf8")) as Workflow }));
const onDevPush = workflows.filter(({ workflow }) => workflow.on.push?.branches?.includes("dev") === true);

type Event = { github: Record<string, Value>; inputs?: Record<string, Value> };
const push: Event = { github: { event_name: "push", ref: "refs/heads/dev", run_id: 101 } };
const pullRequest: Event = {
  github: { event_name: "pull_request", ref: "refs/pull/7/merge", run_id: 102, event: { pull_request: { number: 7 } } },
};

/** A concurrency property for one event: a literal as written, an expression as the server evaluates it. */
const valueOf = (property: string | boolean | undefined, fallback: Value, event: Event): Value =>
  property === undefined
    ? fallback
    : typeof property === "string" && property.trim().startsWith("${{")
      ? evaluate(property, { contexts: event })
      : property;
const policy = (concurrency: Concurrency, event: Event): { cancels: Value; queue: Value } => ({
  cancels: valueOf(concurrency["cancel-in-progress"], false, event),
  queue: valueOf(concurrency.queue, "single", event),
});

test("the workflows a dev push starts are the ones this policy covers", () => {
  expect(onDevPush.map(({ file }) => file).toSorted()).toEqual([
    "ci.yml",
    "deploy-get.yml",
    "deploy-landing.yml",
    "deploy-web.yml",
    "from-zero.yml",
  ]);
});

// A deploy must not be lost: each waiting dev deploy is kept, in order (#2361, #1783, #868).
test("every dev deploy waits its turn: none is cancelled, running or waiting", () => {
  for (const file of ["deploy-get.yml", "deploy-landing.yml", "deploy-web.yml"]) {
    const concurrency = onDevPush.find((entry) => entry.file === file)?.workflow.concurrency;
    if (concurrency === undefined) throw new Error(`${file} has no concurrency group`);
    expect({ file, ...policy(concurrency, push) }).toEqual({ file, cancels: false, queue: "max" });
  }
});

// CI on dev never cancels a running run, and a newer push replaces only the run still WAITING: the tip always gets a
// run, and a green run on a commit covers every merge up to it. Queueing every push would run them one after another
// for hours and take the runner slots pull requests need (LEAD ruling, 2026-11-27).
test("dev CI never cancels a running run and keeps one waiting run, so the tip always runs", () => {
  for (const file of ["ci.yml", "from-zero.yml"]) {
    const concurrency = onDevPush.find((entry) => entry.file === file)?.workflow.concurrency;
    if (concurrency === undefined) throw new Error(`${file} has no concurrency group`);
    expect({ file, ...policy(concurrency, push) }).toEqual({ file, cancels: false, queue: "single" });
  }
});

// GitHub rejects queue: max together with cancel-in-progress: true, so a pull request that cancels its older run keeps
// the single pending slot; a newer push to it still replaces its older run.
test("a pull request run that cancels its older run keeps the single pending slot GitHub requires for that", () => {
  for (const { file, workflow } of onDevPush) {
    if (workflow.on.pull_request === undefined || workflow.concurrency === undefined) continue;
    const { cancels, queue } = policy(workflow.concurrency, pullRequest);
    if (cancels === true) expect({ file, queue }).toEqual({ file, queue: "single" });
  }
});

type Job = { if?: string; env?: Record<string, string>; steps?: { if?: string; run?: string }[] };
const ci = Bun.YAML.parse(readFileSync(join(DIR, "ci.yml"), "utf8")) as {
  on: { pull_request?: { types?: string[] } };
  jobs: Record<string, Job>;
};
const prEvent = (draft: boolean): Event => ({
  github: {
    event_name: "pull_request",
    ref: "refs/pull/7/merge",
    repository: "sisyphuslabs/doriterm",
    event: { pull_request: { number: 7, draft, head: { repo: { full_name: "sisyphuslabs/doriterm" } } } },
  },
});
const runs = (job: Job | undefined, event: Event): Value =>
  job?.if === undefined ? true : evaluate(job.if, { contexts: event });

// A draft pull request skips the e2e suites, and leaving draft starts them; the required reporters fail for a draft so
// it never shows those checks green (LEAD ruling, 2026-11-27).
test("a draft pull request skips the e2e suites, reports them failed, and runs them once it is ready for review", () => {
  expect(ci.on.pull_request?.types).toEqual(expect.arrayContaining(["ready_for_review", "converted_to_draft"]));
  for (const name of ["relay-e2e-part", "web-e2e-shard"]) {
    expect({ name, draft: runs(ci.jobs[name], prEvent(true)) }).toEqual({ name, draft: false });
    expect({ name, ready: runs(ci.jobs[name], prEvent(false)) }).toEqual({ name, ready: true });
    expect({ name, push: runs(ci.jobs[name], push) }).toEqual({ name, push: true });
  }
  // The reporter's draft step must run (and fail) exactly when the pull request is a draft: evaluate its if: against
  // each event, with the env the job sets, rather than matching its text.
  for (const name of ["relay-e2e", "web-e2e"]) {
    const job = ci.jobs[name];
    const draftStep = job?.steps?.find((step) => step.run?.includes("draft: e2e not run"));
    expect({ name, exits: draftStep?.run?.includes("exit 1") === true }).toEqual({ name, exits: true });
    const stepRuns = (event: Event): Value => {
      if (draftStep?.if === undefined) return true;
      const env = Object.fromEntries(
        Object.entries(job?.env ?? {}).map(([key, value]) => [
          key,
          typeof value === "string" && value.trim().startsWith("${{")
            ? String(evaluate(value, { contexts: event }))
            : value,
        ]),
      );
      return evaluate(draftStep.if.startsWith("${{") ? draftStep.if : `\${{ ${draftStep.if} }}`, {
        contexts: { ...event, env },
      });
    };
    expect({ name, draft: stepRuns(prEvent(true)) }).toEqual({ name, draft: true });
    expect({ name, ready: stepRuns(prEvent(false)) }).toEqual({ name, ready: false });
    expect({ name, push: stepRuns(push) }).toEqual({ name, push: false });
  }
});
