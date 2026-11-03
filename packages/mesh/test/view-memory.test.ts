import { describe, expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
import { MAX_MESH_MEMBERS, MAX_RECORDS } from "../src/records/types.ts";
import { Dag } from "../src/view/dag.ts";
import { ViewCache, viewOfRecords } from "../src/view/engine.ts";
import { bigMesh } from "./fixtures/big-mesh.ts";
import { admit, type Draft, found, name, withChainNumbers } from "./fixtures/records.ts";

/** Instances of each class still reachable after a full collection, read from a JSC heap snapshot. */
function reachable(classes: readonly string[]): Record<string, number> {
  Bun.gc(true);
  const snapshot = Bun.generateHeapSnapshot();
  const wanted = new Map(classes.map((cls) => [snapshot.nodeClassNames.indexOf(cls), cls]));
  const out = Object.fromEntries(classes.map((cls) => [cls, 0]));
  // A node is <id, size, class name index, flags>.
  for (let i = 2; i < snapshot.nodes.length; i += 4) {
    const cls = wanted.get(snapshot.nodes[i] ?? -1);
    if (cls !== undefined) out[cls] = (out[cls] ?? 0) + 1;
  }
  return out;
}

const MERGES = 256;

const heapMb = (): number => {
  Bun.gc(true);
  return heapStats().heapSize / 1e6;
};

/** A full mesh whose every later record is a name: each record's past is a context of its own. */
function namesOnly(records: number): Draft[] {
  const drafts: Draft[] = [found("f", "K0")];
  const last = (): string => drafts.at(-1)?.id ?? "f";
  for (let i = 1; i < MAX_MESH_MEMBERS; i++) drafts.push(admit(`a${i}`, "K0", `K${i}`, [last()]));
  while (drafts.length < records) {
    const k = `K${drafts.length % MAX_MESH_MEMBERS}`;
    drafts.push(name(`n${drafts.length}`, k, k, [last()], `${k}-${drafts.length}`));
  }
  return drafts;
}

/** Heap a cache may keep for one cold view at the cap: the history and per-record views, not per-context statuses. */
const NAMES_BUDGET_MB = 96;

describe("M-14: a ViewCache holds one mesh's history, not one engine per merge", () => {
  test("the heap probe sees a Dag that is still held (positive control)", () => {
    const mesh = bigMesh({ records: 32, revokes: 1, seed: 7 });
    const held = reachable(["Dag"]);
    const kept = [new Dag(mesh), new Dag(mesh)];
    expect((reachable(["Dag"])["Dag"] ?? 0) - (held["Dag"] ?? 0)).toBe(kept.length);
  });

  test("single-record merges through one cache leave no per-merge Dag or Engine reachable", () => {
    const mesh = bigMesh({ records: MERGES, revokes: 4, seed: 3 });
    const cache = new ViewCache();
    const held = reachable(["Dag", "Engine"]);
    for (let n = 2; n <= mesh.length; n++) viewOfRecords(mesh.slice(0, n), cache);
    const left = reachable(["Dag", "Engine"]);
    expect((left["Dag"] ?? 0) - (held["Dag"] ?? 0)).toBeLessThanOrEqual(1);
    expect((left["Engine"] ?? 0) - (held["Engine"] ?? 0)).toBeLessThanOrEqual(1);
  });

  test("cache.clear() releases the history and the per-record results it held", () => {
    const mesh = bigMesh({ records: 64, revokes: 2, seed: 5 });
    const cache = new ViewCache();
    viewOfRecords(mesh, cache);
    const held = reachable(["History", "Shared"]);
    cache.clear();
    const left = reachable(["History", "Shared"]);
    expect([left["History"], left["Shared"]]).toEqual([(held["History"] ?? 0) - 1, (held["Shared"] ?? 0) - 1]);
    expect(viewOfRecords(mesh, cache).members).toEqual(viewOfRecords(mesh).members);
  });

  test(`a cold view of a names-only mesh at the cap keeps under ${NAMES_BUDGET_MB} MB in its cache`, () => {
    const records = withChainNumbers(namesOnly(MAX_RECORDS));
    const base = heapMb();
    const cache = new ViewCache();
    expect(viewOfRecords(records, cache).members.length).toBe(MAX_MESH_MEMBERS);
    const held = heapMb() - base;
    console.log(`names-only mesh at ${records.length}: the cache holds ${held.toFixed(0)} MB`);
    expect(held).toBeLessThan(NAMES_BUDGET_MB);
    cache.clear();
  }, 120_000);
});
