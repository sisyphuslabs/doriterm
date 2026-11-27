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

// #2361, #1783: a group keeps one pending run by default, so each dev push replaced the dev run still waiting for a
// runner, and a merge could end with no finished run. queue: max keeps every waiting dev run, in order.
test("every dev push run waits its turn in its group: none is cancelled, running or waiting", () => {
  for (const { file, workflow } of onDevPush) {
    if (workflow.concurrency === undefined) throw new Error(`${file} has no concurrency group`);
    expect({ file, ...policy(workflow.concurrency, push) }).toEqual({ file, cancels: false, queue: "max" });
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
  for (const file of ["ci.yml", "deploy-web.yml", "from-zero.yml"]) {
    const concurrency = onDevPush.find((entry) => entry.file === file)?.workflow.concurrency;
    if (concurrency === undefined) throw new Error(`${file} has no concurrency group`);
    expect({ file, ...policy(concurrency, pullRequest) }).toEqual({ file, cancels: true, queue: "single" });
  }
});
