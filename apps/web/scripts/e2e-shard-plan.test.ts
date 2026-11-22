import { expect, test } from "bun:test";
import { coverageGaps, planShards, reportTimings } from "./e2e-shard-plan.ts";

const load = (shard: readonly string[], timings: Record<string, number>): number =>
  shard.reduce((sum, file) => sum + (timings[file] ?? 0), 0);

test("recorded times put the long files on separate shards, so the slowest shard is as light as it can be", () => {
  const timings = {
    "e2e/a.e2e.ts": 90,
    "e2e/b.e2e.ts": 60,
    "e2e/c.e2e.ts": 50,
    "e2e/d.e2e.ts": 40,
    "e2e/e.e2e.ts": 10,
  };
  const plan = planShards(Object.keys(timings), timings, 2);
  expect(plan.map((shard) => load(shard, timings)).toSorted()).toEqual([120, 130]);
  expect(plan.flat().toSorted()).toEqual(Object.keys(timings).toSorted());
});

test("with no record the files split by count, and a new file weighs the median of the recorded ones", () => {
  const files = ["e2e/a.e2e.ts", "e2e/b.e2e.ts", "e2e/c.e2e.ts", "e2e/d.e2e.ts"];
  expect(planShards(files, {}, 2).map((shard) => shard.length)).toEqual([2, 2]);
  const timings = { "e2e/a.e2e.ts": 100, "e2e/b.e2e.ts": 10, "e2e/c.e2e.ts": 10 };
  // d.e2e.ts has no record and weighs 10 (the median), so it joins the shard without the 100.
  const plan = planShards(files, timings, 2);
  expect(plan.find((shard) => shard.includes("e2e/a.e2e.ts"))).toEqual(["e2e/a.e2e.ts"]);
});

test("every shard computes the same plan, whatever order the files and record come in", () => {
  const timings = { "e2e/x.e2e.ts": 5, "e2e/y.e2e.ts": 5, "e2e/z.e2e.ts": 5 };
  const files = Object.keys(timings);
  expect(planShards(files.toReversed(), timings, 2)).toEqual(planShards(files, timings, 2));
});

test("a report's per-file time sums every test and every retry of nested describes; an all-skipped file is listed at 0", () => {
  const timings = reportTimings(
    {
      suites: [
        {
          file: "a.e2e.ts",
          specs: [{ tests: [{ results: [{ duration: 30 }, { duration: 5 }] }] }],
          suites: [{ file: "a.e2e.ts", specs: [{ tests: [{ results: [{ duration: 7 }] }] }] }],
        },
        { file: "skipped.e2e.ts", specs: [{ tests: [{ results: [] }] }] },
      ],
    },
    "e2e/",
  );
  expect(timings).toEqual({ "e2e/a.e2e.ts": 42, "e2e/skipped.e2e.ts": 0 });
});

test("coverage names a spec no shard ran, one run by two shards, and a run of a file that is not a spec", () => {
  const all = ["e2e/a.e2e.ts", "e2e/b.e2e.ts", "e2e/c.e2e.ts"];
  expect(coverageGaps(all, [["e2e/a.e2e.ts"], ["e2e/b.e2e.ts", "e2e/c.e2e.ts"]])).toEqual([]);
  expect(
    coverageGaps(all, [
      ["e2e/a.e2e.ts", "e2e/b.e2e.ts"],
      ["e2e/b.e2e.ts", "e2e/x.e2e.ts"],
    ]),
  ).toEqual(["not a spec file: e2e/x.e2e.ts", "not run: e2e/c.e2e.ts", "run by 2 shards: e2e/b.e2e.ts"]);
});
