import { expect, test } from "bun:test";
import { MAX_RECORDS } from "../src/records/types.ts";
import { ViewCache, viewOf, viewOfRecords } from "../src/view/engine.ts";
import { bigMesh } from "./fixtures/big-mesh.ts";
import { signScenario } from "./fixtures/signed.ts";

/**
 * M-14 at the cap: 4096 records, 64 revokes, each concurrent with a record of its subject (an ack or a name), so
 * every later view holds 64 conflicts. Measured on a development machine under load average 44-53, eight runs:
 * a cold view took 0.68-1.84 s. A review measured a single cold view at 3.3 s under load average 40, 1.8x under the
 * old 6 s budget, so the cold test takes the faster of two views against 10 s: over 5x the slowest measured run.
 *
 * A merge is gated against a cold view of the same set in the same process, not against a wall-clock figure, so load
 * slows both sides together. On a 40-core host at load average 52-58, 16 runs of this file 8 at a time: the merge
 * median was 24-59 ms against a cold view of 2.0-4.1 s, 0.7-2.9% of it, and the gate is 10%. The old absolute 50 ms
 * gate failed 2 of those 16 runs. A merge that re-evaluates the whole set (no state carried across merges) costs
 * 97-114% of a cold view and fails. The absolute median is also held under ten times the design's 50 ms honest-mesh
 * budget, so a cold-path slowdown cannot widen the ratio's window. The previous engine grew with the cube of the set:
 * 0.16 s at 128 records, 0.88 s at 256, 7.1 s at 512, so it misses both.
 */
const COLD_BUDGET_MS = 10_000;
/** A merge must cost under this share of a cold view of the same set. */
const MERGE_SHARE_OF_COLD = 0.1;
const DESIGN_MERGE_MS = 50;
const MERGES = 64;

const mesh = bigMesh({ records: MAX_RECORDS, revokes: 64, seed: 20261103 });

const timed = (run: () => void): number => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

test("M-14: a cold view of 4096 records with 64 revokes stays within its budget", () => {
  const ms = Math.min(
    timed(() => void viewOfRecords(mesh).eff.size),
    timed(() => void viewOfRecords(mesh).eff.size),
  );
  console.log(`cold view: ${mesh.length} records in ${ms.toFixed(0)} ms, faster of two (budget ${COLD_BUDGET_MS} ms)`);
  expect(ms).toBeLessThan(COLD_BUDGET_MS);
}, 120_000);

test("M-14: one merge at 4096 records costs under a tenth of a cold view of the same set (median of 64 merges)", () => {
  const signed = signScenario(mesh).records;
  const cold = (): number => timed(() => void viewOf(signed).eff.size);
  const coldBefore = cold();
  const cache = new ViewCache();
  viewOf(signed.slice(0, signed.length - MERGES), cache);
  const merges: number[] = [];
  for (let n = signed.length - MERGES + 1; n <= signed.length; n++)
    merges.push(timed(() => void viewOf(signed.slice(0, n), cache)));
  const coldMs = Math.min(coldBefore, cold());
  const sorted = merges.toSorted((a, b) => a - b);
  const median = sorted[MERGES / 2] ?? Number.POSITIVE_INFINITY;
  console.log(
    `merge at ${signed.length}: median ${median.toFixed(1)} ms (design budget ${DESIGN_MERGE_MS} ms), max ` +
      `${(sorted.at(-1) ?? 0).toFixed(1)} ms; cold view ${coldMs.toFixed(0)} ms; merge/cold ${(median / coldMs).toFixed(4)} ` +
      `(gate ${MERGE_SHARE_OF_COLD})`,
  );
  expect(median / coldMs).toBeLessThan(MERGE_SHARE_OF_COLD);
  expect(median).toBeLessThan(10 * DESIGN_MERGE_MS);
}, 120_000);
