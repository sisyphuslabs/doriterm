// The heap a ViewCache keeps after one cold view of a stress mesh (test/fixtures/heap-meshes.ts). Run as its own process,
// `bun test/fixtures/cache-heap.ts <shape>`, so no other test's garbage or live objects move the reading; it prints
// {"heldMb": n, ...}: what clear() releases. `admits-only` and `partition-large` back the figures in the design's
// section 8.4 and residual 7; the tests use the others.

import { heapStats } from "bun:jsc";
import { MAX_RECORDS } from "../../src/records/types.ts";
import { ViewCache } from "../../src/view/engine.ts";
import type { Rec } from "../../src/view/dag.ts";
import { admitsOnly, namesOnly, partition } from "./heap-meshes.ts";
import { type Draft, withChainNumbers } from "./records.ts";

const SHAPES: Readonly<Record<string, () => Draft[]>> = {
  "names-only": () => namesOnly(MAX_RECORDS),
  "admits-only-2048": () => admitsOnly(2048),
  "admits-only": () => admitsOnly(MAX_RECORDS),
  partition: () => partition({ common: 1000, branch: 400, revokes: 4 }),
  "partition-large": () => partition({ common: 1500, branch: 1200, revokes: 8 }),
};

const heapMb = (): number => {
  Bun.gc(true);
  Bun.gc(true);
  return heapStats().heapSize / 1e6;
};

interface Evaluated {
  readonly members: number;
  /** The call's Engine and Dag: garbage once the call returns. */
  readonly call: readonly WeakRef<object>[];
  /** The cache's History: garbage once clear() has dropped the cache's state. */
  readonly history: WeakRef<object>;
}

/** The cold view, in a frame of its own, through the same path as viewOfRecords(records, cache) takes. */
function evaluate(records: readonly Rec[], cache: ViewCache): Evaluated {
  const engine = cache.engineFor(records);
  const members = engine.full().members.length;
  return { members, call: [new WeakRef(engine), new WeakRef(engine.dag)], history: new WeakRef(engine.dag.history) };
}

/**
 * Overwrites the stack region an earlier call used. JSC scans the stack conservatively, so a dead slot that still
 * holds the call's Engine keeps it, its Dag and the cache's state reachable, and a reading would count them.
 */
function scrubStack(depth: number): number {
  const [a, b, c, d, e, f, g, h] = [depth, depth + 1, depth + 2, depth + 3, depth + 4, depth + 5, depth + 6, depth + 7];
  if (depth === 0) return a + b + c + d + e + f + g + h;
  return (scrubStack(depth - 1) + a + b + c + d + e + f + g + h) % 1_000_003;
}

/**
 * Collects until every ref is cleared, so a reading never counts an object that is only garbage. A WeakRef keeps its
 * target alive until the end of the job that created or dereferenced it, so each round first yields one event-loop
 * turn, then collects, then looks. Fails rather than read a wrong figure.
 */
async function collected(refs: readonly WeakRef<object>[], what: string, round = 0): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  scrubStack(4000);
  Bun.gc(true);
  if (refs.every((ref) => ref.deref() === undefined)) return;
  if (round === 63) throw new Error(`${what} is still reachable after 64 collections`);
  return collected(refs, what, round + 1);
}

if (import.meta.main) {
  const build = SHAPES[process.argv[2] ?? ""];
  if (build === undefined) throw new Error(`shape: one of ${Object.keys(SHAPES).join(", ")}`);
  const records = withChainNumbers(build());
  const base = heapMb();
  const cache = new ViewCache();
  const started = performance.now();
  const { members, call, history } = evaluate(records, cache);
  const ms = performance.now() - started;
  await collected(call, "the evaluating Engine or its Dag");
  const withCache = heapMb();
  cache.clear();
  await collected([history], "the cache's History after clear()");
  const released = withCache - heapMb();
  // The cache's memory is what clear() releases; a reading against the baseline alone moves with whatever the
  // collector had not yet returned when the baseline was taken.
  console.log(JSON.stringify({ heldMb: released, overBaseMb: withCache - base, members, records: records.length, ms }));
}
