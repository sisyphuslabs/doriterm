import { describe, expect, test } from "bun:test";
import { KEPT_DAGS } from "./fixtures/view-reachable.ts";

/** Prints a fixture's one JSON reading, run in a fresh bun process so no other test's heap moves or slows it. */
async function reading(fixture: string, arg: string): Promise<unknown> {
  const child = Bun.spawn([process.execPath, new URL(fixture, import.meta.url).pathname, arg], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(code).toBe(0);
  return JSON.parse(text);
}

/** The class counts a probe of test/fixtures/view-reachable.ts read in its own heap. */
async function reachableIn(probe: string): Promise<{ counts: Record<string, number> } & Record<string, unknown>> {
  const out = await reading("./fixtures/view-reachable.ts", probe);
  if (typeof out !== "object" || out === null || !("counts" in out) || typeof out.counts !== "object")
    throw new Error(`unreadable probe reading: ${JSON.stringify(out)}`);
  return out as { counts: Record<string, number> } & Record<string, unknown>;
}

/**
 * The bound for each heap-probe test: one bun process that runs the probe and takes one debug snapshot of its own heap
 * (16-19k nodes, whatever the test process holds). On agents-seoul-1, 20 runs each at load1 67-115 took at most 1.45 s
 * (single-record) and 0.45 s (clear), and 20 runs each at load1 115-130 took at most 2.29 s and 0.96 s. The bound is that
 * worst case with about 3x margin. The in-process probes it replaces snapshotted the whole test process: 72k nodes after
 * the mesh suite, and 41 s in rev-157's whole-repository run (#542).
 */
export const HEAP_PROBE_TEST_MS = 7_000;
/**
 * The bound for each cache-heap test, per shape: a cold view in a fresh bun process, CPU-bound, so its wall time follows
 * the load. Worst of 20 runs each on agents-seoul-1 at load1 67-130: names-only 66.4 s (about 27 s of CPU in the cold
 * view at the cap), admits-only-2048 20.9 s, partition 6.95 s. Each bound is that worst case with about 3x margin.
 */
export const CACHE_HEAP_TEST_MS = { "names-only": 200_000, "admits-only-2048": 63_000, partition: 21_000 } as const;

/** Heap one cold view at the cap may leave in a cache for a names-only mesh: views and history, no per-context statuses. */
const NAMES_BUDGET_MB = 96;
/** For the partition shape: a common past per accuser/record pair is n/32 words of bits, not a Set of ids. */
const PARTITION_BUDGET_MB = 24;
/**
 * For 2048 admissions: per-record views keep governing, not admitter, names or hostIds of every governed key. Measured
 * 210 MB with the trim and 433 MB without it.
 */
const ADMITS_BUDGET_MB = 320;

/** The heap a cache holds after one cold view of `shape`, read in a fresh bun process (test/fixtures/cache-heap.ts). */
async function heldMb(shape: string): Promise<number> {
  const out = await reading("./fixtures/cache-heap.ts", shape);
  if (typeof out !== "object" || out === null || !("heldMb" in out) || typeof out.heldMb !== "number")
    throw new Error(`unreadable heap reading: ${JSON.stringify(out)}`);
  console.log(`${shape}: the cache holds ${out.heldMb.toFixed(1)} MB`);
  return out.heldMb;
}

describe("M-14: a ViewCache holds one mesh's history, not one engine per merge", () => {
  test(
    "single-record merges through one cache leave no per-merge Dag or Engine reachable",
    async () => {
      // One snapshot in a process that built no Dag before: the cache may keep one, the positive control keeps two.
      const { counts } = await reachableIn("single-record");
      expect(counts["Dag"] ?? 0).toBeGreaterThanOrEqual(KEPT_DAGS);
      expect((counts["Dag"] ?? 0) - KEPT_DAGS).toBeLessThanOrEqual(1);
      expect(counts["Engine"] ?? 0).toBeLessThanOrEqual(1);
    },
    HEAP_PROBE_TEST_MS,
  );

  test(
    "cache.clear() releases the history and the per-record results it held",
    async () => {
      // One snapshot with a cleared cache and an uncleared control: only the control's History and Shared remain.
      const { counts, members, fresh } = await reachableIn("clear");
      expect([counts["History"], counts["Shared"]]).toEqual([1, 1]);
      expect(members).toEqual(fresh);
    },
    HEAP_PROBE_TEST_MS,
  );

  test(
    `a cold view of a names-only mesh at the cap keeps under ${NAMES_BUDGET_MB} MB in its cache`,
    async () => {
      const held = await heldMb("names-only");
      expect(held).toBeGreaterThan(0);
      expect(held).toBeLessThan(NAMES_BUDGET_MB);
    },
    CACHE_HEAP_TEST_MS["names-only"],
  );

  test(
    `a partition with revokes across it keeps under ${PARTITION_BUDGET_MB} MB in its cache`,
    async () => {
      const held = await heldMb("partition");
      expect(held).toBeGreaterThan(0);
      expect(held).toBeLessThan(PARTITION_BUDGET_MB);
    },
    CACHE_HEAP_TEST_MS.partition,
  );

  test(
    `2048 admissions, every one a member, keep under ${ADMITS_BUDGET_MB} MB in the cache`,
    async () => {
      const held = await heldMb("admits-only-2048");
      expect(held).toBeGreaterThan(0);
      expect(held).toBeLessThan(ADMITS_BUDGET_MB);
    },
    CACHE_HEAP_TEST_MS["admits-only-2048"],
  );
});
