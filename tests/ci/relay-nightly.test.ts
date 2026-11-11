import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  latencyCaseTitle,
  LATENCY_MODES,
  LATENCY_RTTS,
  NIGHTLY_TAG,
} from "../../apps/web/e2e/keystroke-latency-cases.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

type Step = { readonly name?: string; readonly run?: string; readonly uses?: string };
type Workflow = {
  readonly on: Record<string, unknown>;
  readonly jobs: Record<string, { readonly steps?: readonly Step[] }>;
};
const workflow = (path: string): Workflow => Bun.YAML.parse(read(path)) as Workflow;
const runs = (wf: Workflow): readonly string[] =>
  Object.values(wf.jobs).flatMap((job) => (job.steps ?? []).map((step) => step.run ?? ""));

test("the rtt 150 cases of the keystroke latency matrix, and only they, carry the nightly tag (#2028)", () => {
  const tagged = LATENCY_RTTS.flatMap((rtt) =>
    LATENCY_MODES.map((mode) => [rtt, latencyCaseTitle(rtt, mode).includes(NIGHTLY_TAG)] as const),
  );
  expect(tagged.filter(([, nightly]) => nightly).map(([rtt]) => rtt)).toEqual([150, 150]);
  expect(tagged.filter(([, nightly]) => !nightly).map(([rtt]) => rtt)).toEqual([0, 0, 300, 300]);
  // The spec names its cases through this helper, so a title written by hand cannot drop the tag unnoticed.
  expect(read("apps/web/e2e/keystroke-latency-relay.e2e.ts")).toContain("test(latencyCaseTitle(rtt, mode)");
});

test("pull requests run the keystroke latency spec without its nightly rows", () => {
  const step = runs(workflow(".github/workflows/ci.yml")).find((run) =>
    run.includes("e2e/keystroke-latency-relay.e2e.ts"),
  );
  expect(step).toBeDefined();
  expect(step).toContain(`--grep-invert ${NIGHTLY_TAG}`);
});

test("a scheduled, dispatchable job runs only the nightly rows, with the relay checkout", () => {
  const nightly = workflow(".github/workflows/relay-nightly.yml");
  expect(Object.keys(nightly.on).toSorted()).toEqual(["schedule", "workflow_dispatch"]);
  const all = runs(nightly);
  expect(all).toContain("bun run relay:fetch");
  const spec = all.find((run) => run.includes("e2e/keystroke-latency-relay.e2e.ts"));
  expect(spec).toContain(`--grep ${NIGHTLY_TAG}`);
  expect(spec).toContain("--workers=1");
});
