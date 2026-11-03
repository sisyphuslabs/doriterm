import { expect, test } from "bun:test";
import { MAX_RECORDS } from "../src/records/types.ts";
import { type ViewCache, viewOf, viewOfRecords } from "../src/view/engine.ts";
import { bigMesh } from "./fixtures/big-mesh.ts";
import { signScenario } from "./fixtures/signed.ts";

/**
 * M-14 at the cap: 4096 records, 64 revokes, each concurrent with a record of its subject (an ack or a name), so
 * every later view holds 64 conflicts. Measured on a development machine under load average 44-53, eight runs:
 * a cold view took 0.68-1.84 s, and one merge through a warm cache (signed records, viewOf) had a median of
 * 12-24 ms over 64 merges. The cold budget leaves about 3x that; the merge budget is the design's 50 ms. The previous
 * engine grew with the cube of the set: 0.16 s at 128 records, 0.88 s at 256, 7.1 s at 512, so it misses both.
 */
const COLD_BUDGET_MS = 6000;
const MERGE_BUDGET_MS = 50;
const MERGES = 64;

const mesh = bigMesh({ records: MAX_RECORDS, revokes: 64, seed: 20261103 });

const timed = (run: () => void): number => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

test("M-14: a cold view of 4096 records with 64 revokes stays within its budget", () => {
  const ms = timed(() => void viewOfRecords(mesh).eff.size);
  console.log(`cold view: ${mesh.length} records in ${ms.toFixed(0)} ms (budget ${COLD_BUDGET_MS} ms)`);
  expect(mesh.length).toBe(MAX_RECORDS);
  expect(ms).toBeLessThan(COLD_BUDGET_MS);
}, 120_000);

test("M-14: one merge at 4096 records re-evaluates within 50 ms (median of 64 merges through one cache)", () => {
  const signed = signScenario(mesh).records;
  const cache: ViewCache = new Map();
  viewOf(signed.slice(0, signed.length - MERGES), cache);
  const merges: number[] = [];
  for (let n = signed.length - MERGES + 1; n <= signed.length; n++)
    merges.push(timed(() => void viewOf(signed.slice(0, n), cache)));
  const sorted = merges.toSorted((a, b) => a - b);
  const median = sorted[MERGES / 2] ?? Number.POSITIVE_INFINITY;
  console.log(`merge at ${signed.length}: median ${median.toFixed(1)} ms, max ${(sorted.at(-1) ?? 0).toFixed(1)} ms`);
  expect(median).toBeLessThan(MERGE_BUDGET_MS);
}, 120_000);
