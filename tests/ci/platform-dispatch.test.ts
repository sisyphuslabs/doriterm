import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, type Value } from "./gh-expression.ts";

type Job = { if?: string };
type Workflow = {
  on: Record<string, unknown>;
  concurrency: { group: string; "cancel-in-progress": string | boolean };
  jobs: Record<string, Job>;
};

const ci = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "..", "..", ".github", "workflows", "ci.yml"), "utf8"),
) as Workflow;

/** The jobs that build or test on a platform the Linux PR jobs do not cover (#1886, #2361). */
const PLATFORM = ["install-macos", "android", "ios", "desktop", "desktop-macos", "windows-private-state"] as const;

type Contexts = { readonly github: { readonly event_name: string; readonly ref: string; readonly workflow: string } };
const event = (event_name: string, ref: string): Contexts => ({ github: { event_name, ref, workflow: "CI" } });
const runs = (job: string, contexts: Contexts): Value => {
  const condition = ci.jobs[job]?.if;
  if (condition === undefined) throw new Error(`ci.yml has no ${job} job, or it lost its if:`);
  return evaluate(condition, { contexts: contexts as unknown as Record<string, Value> });
};

test("ci.yml can be dispatched by hand, so a maintainer can ask for its platform jobs (#1886)", () => {
  expect(Object.keys(ci.on)).toContain("workflow_dispatch");
});

test("every platform job runs on a dispatch at a PR's branch and on a push to dev, and on nothing else (#1886)", () => {
  for (const job of PLATFORM) {
    expect({ job, dispatch: runs(job, event("workflow_dispatch", "refs/heads/dt-1886/branch")) }).toEqual({
      job,
      dispatch: true,
    });
    expect({ job, dev: runs(job, event("push", "refs/heads/dev")) }).toEqual({ job, dev: true });
    // Ordinary PR runs and pushes elsewhere stay as they were: no platform runner is paid for unless someone asks.
    expect({ job, pr: runs(job, event("pull_request", "refs/pull/1/merge")) }).toEqual({ job, pr: false });
    expect({ job, other: runs(job, event("push", "refs/heads/feature")) }).toEqual({ job, other: false });
    expect({ job, queue: runs(job, event("merge_group", "refs/heads/gh-readonly-queue/dev/x")) }).toEqual({
      job,
      queue: false,
    });
  }
});

/** A workflow value with `${{ }}` parts, as GitHub fills it in: one whole expression keeps its type. */
const fill = (template: string, contexts: Contexts): Value => {
  const run = { contexts: contexts as unknown as Record<string, Value> };
  const whole = /^\$\{\{\s*([^]*?)\s*\}\}$/.exec(template.trim());
  if (whole !== null && template.split("${{").length === 2) return evaluate(whole[1] ?? "", run);
  return template.replace(/\$\{\{\s*([^]*?)\s*\}\}/g, (_, expression: string) => String(evaluate(expression, run)));
};

test("a dispatch on a PR's branch runs in that branch's concurrency group, not dev's, and is never cancelled by it (#1886)", () => {
  const dispatch = event("workflow_dispatch", "refs/heads/dt-1886/branch");
  expect(fill(ci.concurrency.group, dispatch)).not.toBe(fill(ci.concurrency.group, event("push", "refs/heads/dev")));
  expect(fill(String(ci.concurrency["cancel-in-progress"]), dispatch)).toBe(false);
});
