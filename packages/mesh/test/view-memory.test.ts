import { describe, expect, test } from "bun:test";
import { ViewCache, viewOfRecords } from "../src/view/engine.ts";
import { bigMesh } from "./fixtures/big-mesh.ts";

/** Instances of each class still reachable after a full collection, read from a JSC heap snapshot. */
function reachable(classes: readonly string[]): Record<string, number> {
  Bun.gc(true);
  const snapshot = Bun.generateHeapSnapshot();
  const wanted = new Map(classes.map((name) => [snapshot.nodeClassNames.indexOf(name), name]));
  const out = Object.fromEntries(classes.map((name) => [name, 0]));
  // A node is <id, size, class name index, flags>.
  for (let i = 2; i < snapshot.nodes.length; i += 4) {
    const name = wanted.get(snapshot.nodes[i] ?? -1);
    if (name !== undefined) out[name] = (out[name] ?? 0) + 1;
  }
  return out;
}

const MERGES = 256;

describe("M-14: a ViewCache holds one mesh's history, not one engine per merge", () => {
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
});
