import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BenchRun,
  type Thresholds,
  compareRuns,
  frameStats,
  gridOf,
  median,
  renderTable,
  workloadBytes,
} from "./render-stats.ts";

const run = (
  panes: number,
  over: Partial<BenchRun["visible"]> = {},
  hidden: Partial<BenchRun["hidden"]> = {},
  unpaced: Partial<BenchRun["unpaced"]> = {},
  closeMs: readonly number[] = [40, 50, 60, 50, 45],
) =>
  ({
    build: "x",
    panes,
    visible: {
      frames: 200,
      frameP50: 16.7,
      frameP95: 20,
      frameMax: 40,
      busyShare: 0.3,
      longTasks: 2,
      longTaskMs: 120,
      catchUpMs: 50,
      heapMB: 40,
      domNodes: 5_000,
      ...over,
    },
    hidden: { busyShare: 0.05, showCatchUpMs: 300, ...hidden },
    unpaced: { drawnBytesPerSec: 2_000_000, ...unpaced },
    prompt: { closeMs },
  }) satisfies BenchRun;

const LIMITS: Thresholds = {
  frameP95: { ratio: 1.25, floor: 4 },
  busyShare: { ratio: 1.25, floor: 0.05, ceiling: 1 },
  longTaskMs: { ratio: 1.5, floor: 500 },
  catchUpMs: { ratio: 1.5, floor: 100 },
  drawnBytesPerSec: { ratio: 0.8, floor: 0 },
  heapMB: { ratio: 1.25, floor: 10 },
  hiddenBusyShare: { ratio: 1.5, floor: 0.05 },
  showCatchUpMs: { ratio: 1.5, floor: 200 },
  closePromptMs: { ratio: 1.5, floor: 50, max: 200 },
};

/** The limits the release gate runs with, as bench/run.ts reads them. */
const SHIPPED = (JSON.parse(readFileSync(join(import.meta.dir, "thresholds.json"), "utf8")) as { limits: Thresholds })
  .limits;

describe("frameStats", () => {
  test("turns frame timestamps into nearest-rank interval percentiles, leaving the first frame out", () => {
    // 101 timestamps: 100 intervals, 95 of 16 ms and 5 of 50 ms.
    const stamps = [0];
    for (let i = 0; i < 95; i += 1) stamps.push((stamps.at(-1) ?? 0) + 16);
    for (let i = 0; i < 5; i += 1) stamps.push((stamps.at(-1) ?? 0) + 50);
    expect(frameStats(stamps)).toEqual({ frames: 100, p50: 16, p95: 16, max: 50 });
  });

  test("refuses a window too short to give a p95", () => {
    expect(() => frameStats([0, 16, 32])).toThrow(/at least 20 frames/);
  });
});

describe("gridOf", () => {
  test("lays panes out in rows that hold every pane, wider than tall", () => {
    expect(gridOf(1)).toEqual([1]);
    expect(gridOf(15)).toEqual([5, 5, 5]);
    const fifty = gridOf(50);
    expect(fifty.reduce((a, b) => a + b, 0)).toBe(50);
    expect(Math.max(...fifty) - Math.min(...fifty)).toBeLessThanOrEqual(1);
    expect(fifty.length).toBeLessThan(Math.max(...fifty));
  });
});

test("workloadBytes counts what every pane's program writes in one phase", () => {
  // chunk printed with a newline per tick, then the phase's end line.
  // A two-digit phase, so its end line is longer than phase 1's.
  expect(workloadBytes({ chunk: "abc", ticks: 4 }, 7, 12)).toBe(4 * 4 + "bench-end-12-7\n".length);
});

test("median of an even count is the mean of the middle two", () => {
  expect(median([4, 1, 3, 2])).toBe(2.5);
  expect(median([5])).toBe(5);
});

describe("compareRuns", () => {
  test("fails a Close prompt past its 200 ms budget even when the baseline was as slow (#986)", () => {
    const slow = [210, 220, 230, 215, 225];
    const verdict = compareRuns([run(15, {}, {}, {}, slow)], [run(15, {}, {}, {}, slow)], LIMITS);
    expect(verdict.regressions.map((row) => `${row.metric}:${row.candidate}:${row.limit}`)).toEqual([
      "closePromptMs:220:200",
    ]);
  });

  test("reads a Close prompt as the median of its clicks, so one slow click does not fail the gate", () => {
    const verdict = compareRuns([run(15)], [run(15, {}, {}, {}, [40, 900, 50, 45, 60])], LIMITS);
    expect(verdict.regressions).toEqual([]);
  });

  test("passes a candidate within the recorded limits", () => {
    const verdict = compareRuns([run(15)], [run(15, { frameP95: 22 })], LIMITS);
    expect(verdict.regressions).toEqual([]);
  });

  test("fails a slower frame p95 only past both the ratio and the absolute floor", () => {
    // 20 -> 26: 1.3x and +6 ms, past 1.25x and 4 ms.
    const slow = compareRuns([run(50)], [run(50, { frameP95: 26 })], LIMITS);
    expect(slow.regressions.map((row) => `${row.panes}:${row.metric}`)).toEqual(["50:frameP95"]);
    // 2 -> 3 ms is 1.5x but only +1 ms: under the floor, noise.
    const small = compareRuns([run(1, { frameP95: 2 })], [run(1, { frameP95: 3 })], LIMITS);
    expect(small.regressions).toEqual([]);
  });

  test("reads drawn bytes per second as worse when it drops", () => {
    const verdict = compareRuns([run(50)], [run(50, {}, {}, { drawnBytesPerSec: 1_400_000 })], LIMITS);
    expect(verdict.regressions.map((row) => row.metric)).toEqual(["drawnBytesPerSec"]);
  });

  test("fails long-task time past the shipped ratio and floor, where main busy is already saturated", () => {
    // #842's 50-pane regression: 756 -> 1,695 ms of long tasks with the main thread busy in both builds.
    const saturated = { busyShare: 0.97, longTaskMs: 756 };
    const verdict = compareRuns([run(50, saturated)], [run(50, { busyShare: 0.98, longTaskMs: 1_695 })], SHIPPED);
    expect(verdict.regressions.map((row) => row.metric)).toEqual(["longTaskMs"]);
    // 0 -> 400 ms is past any ratio but under the floor: noise.
    expect(compareRuns([run(1, { longTaskMs: 0 })], [run(1, { longTaskMs: 400 })], SHIPPED).regressions).toEqual([]);
  });

  test("reports main busy ungated where its limit is past the share's ceiling, and gates it below", () => {
    const fifty = compareRuns([run(50, { busyShare: 0.97 })], [run(50, { busyShare: 0.99 })], LIMITS).rows;
    expect(fifty.find((row) => row.metric === "busyShare")).toMatchObject({ gated: false, regressed: false });
    const fifteen = compareRuns([run(15, { busyShare: 0.3 })], [run(15, { busyShare: 0.5 })], LIMITS);
    expect(fifteen.regressions.map((row) => row.metric)).toEqual(["busyShare"]);
  });

  test("compares the medians of repeated runs, so one noisy run does not fail the gate", () => {
    const baseline = [run(15), run(15), run(15)];
    const candidate = [run(15), run(15, { frameP95: 80 }), run(15)];
    expect(compareRuns(baseline, candidate, LIMITS).regressions).toEqual([]);
  });

  test("checks the hidden-tab cost apart from the visible one", () => {
    const verdict = compareRuns([run(15)], [run(15, {}, { busyShare: 0.2 })], LIMITS);
    expect(verdict.regressions.map((row) => row.metric)).toEqual(["hiddenBusyShare"]);
  });

  test("refuses a candidate with a pane count the baseline did not run", () => {
    expect(() => compareRuns([run(15)], [run(50)], LIMITS)).toThrow(/no baseline run with 50 panes/);
  });
});

test("renderTable prints one row per build and pane count", () => {
  const table = renderTable([run(1), run(50)]);
  expect(table.split("\n")[0]).toStartWith("| Build | Panes |");
  expect(table).toContain("| x | 1 |");
  expect(table).toContain("| x | 50 |");
});
