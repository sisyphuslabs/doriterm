import { describe, expect, test } from "bun:test";
import { Dag, type Rec } from "../src/view/dag.ts";
import { Engine, type ViewCache, viewOf, viewOfRecords } from "../src/view/engine.ts";
import { bigMesh } from "./fixtures/big-mesh.ts";
import { randomDag } from "./fixtures/random-dag.ts";
import { ack, admit, found, name, revoke, withChainNumbers } from "./fixtures/records.ts";
import { lineageScenarios } from "./fixtures/scenarios-lineage.ts";
import { staleForkScenarios } from "./fixtures/scenarios-stale.ts";
import { signScenario } from "./fixtures/signed.ts";
import { Dag as LegacyDag } from "./oracle/legacy/dag.ts";
import {
  Engine as LegacyEngine,
  viewOf as legacyViewOf,
  viewOfRecords as legacyViewOfRecords,
} from "./oracle/legacy/engine.ts";
import { attack, honestHistory, pick, rng } from "./sim/world.ts";

interface Shaped {
  readonly members: Iterable<string>;
  readonly overCap: Iterable<string>;
  readonly revoked: Iterable<string>;
  readonly eff: Iterable<string>;
  readonly noise: Iterable<readonly [string, string]>;
  readonly admitter: Iterable<readonly [string, string]>;
  readonly name: Iterable<readonly [string, string]>;
  readonly governing?: Iterable<readonly [string, string]>;
  readonly hostId?: Iterable<readonly [string, string]>;
}

/** Every field of a view, in its own iteration order: byte-identical means this string is identical. */
const shape = (v: Shaped): string =>
  JSON.stringify([
    [...v.members],
    [...v.overCap],
    [...v.revoked],
    [...v.eff],
    [...v.noise],
    [...v.admitter],
    [...(v.governing ?? [])],
    [...v.name],
    [...(v.hostId ?? [])],
  ]);

const same = (records: readonly Rec[], cache?: ViewCache): boolean =>
  shape(viewOfRecords(records, cache)) === shape(legacyViewOfRecords(records));

/** The full view and view(past(x)) for every record x, so the per-record views and their lazy eff are compared too. */
function sameEverywhere(records: readonly Rec[]): boolean {
  const e = new Engine(new Dag(records));
  const l = new LegacyEngine(new LegacyDag(records));
  if (shape(e.full()) !== shape(l.full())) return false;
  return records.every((r) => {
    const a = e.before(r.id);
    const b = l.before(r.id);
    return a === undefined || b === undefined ? a === b : shape(a) === shape(b);
  });
}

const SEEDS = [1, 2, 3, 4, 5, 7, 11, 13] as const;
const SLOW = 120_000;

describe("M-14: the incremental viewOf is byte-identical to the previous engine (the oracle)", () => {
  test(
    "seeded adversarial histories (honest writers, then a revoked key's backdated records)",
    () => {
      let checked = 0;
      for (const seed of SEEDS) {
        const r = rng(seed);
        for (let i = 0; i < 25; i++) {
          const w = honestHistory(r, 8 + Math.floor(r.next() * 14));
          const members = w.full().members;
          if (members.length > 1) {
            const pool = w.records.map((x) => x.id);
            attack(r, w, [pick(r, members)], members, pool, 3 + Math.floor(r.next() * 6));
          }
          expect(sameEverywhere(w.records)).toBe(true);
          checked++;
        }
      }
      expect(checked).toBe(200);
    },
    SLOW,
  );

  test(
    "arbitrary DAGs with forks, counter gaps, fractional counters and duplicate prev",
    () => {
      for (const seed of SEEDS) {
        const r = rng(seed + 1000);
        for (let i = 0; i < 12; i++) expect(sameEverywhere(randomDag(r, 12 + Math.floor(r.next() * 40)))).toBe(true);
      }
    },
    SLOW,
  );

  test("an ack that is the only testimony on a conflict decides it, with the non-ack records unchanged", () => {
    // A revokes B while B renames itself; C acks the rename without the revoke. past(x1) and past(x2) hold the same
    // non-ack records, and only C's ack in past(x2) breaks the 0:0 tie that voids the rename in past(x1).
    const records = withChainNumbers([
      found("f", "A"),
      admit("aB", "A", "B", ["f"]),
      admit("aC", "A", "C", ["aB"]),
      admit("aD", "A", "D", ["aC"]),
      revoke("v", "A", ["B"], ["aD"]),
      name("y", "B", "B", ["aD"]),
      ack("w", "C", ["y"]),
      ack("x1", "D", ["v", "y"]),
      ack("x2", "D", ["x1", "w"]),
    ]);
    expect(sameEverywhere(records)).toBe(true);
    expect(sameEverywhere(records.filter((r) => r.id !== "x2"))).toBe(true);
    const e = new Engine(new Dag(records));
    expect(e.before("x1")?.eff.has("y")).toBe(false);
    expect(e.before("x2")?.eff.has("y")).toBe(true);
  });

  test("P1-P13 and every M-5 scenario", () => {
    for (const s of [...staleForkScenarios, ...lineageScenarios])
      expect(sameEverywhere(withChainNumbers(s.records))).toBe(true);
  });

  test(
    "large meshes with revokes concurrent with acks and with names",
    () => {
      for (const seed of SEEDS.slice(0, 4))
        for (const records of [64, 160]) {
          const mesh = bigMesh({ records, revokes: records / 32, seed, forks: 0.2 });
          expect(same(mesh)).toBe(true);
        }
    },
    SLOW,
  );

  test(
    "one cache through growth and through smaller sets: each merge equals a fresh evaluation",
    () => {
      for (const seed of SEEDS.slice(0, 3)) {
        const mesh = bigMesh({ records: 128, revokes: 4, seed, forks: 0.25 });
        const cache: ViewCache = new Map();
        for (let n = 2; n <= mesh.length; n += 9) expect(same(mesh.slice(0, n), cache)).toBe(true);
        expect(same(mesh, cache)).toBe(true);
        expect(same(mesh.slice(0, 40), cache)).toBe(true);
      }
      const r = rng(77);
      for (let i = 0; i < 30; i++) {
        const w = honestHistory(r, 16);
        const cache: ViewCache = new Map();
        for (const ids of w.know.values()) expect(same(w.subset(ids), cache)).toBe(true);
        expect(same(w.records, cache)).toBe(true);
      }
    },
    SLOW,
  );

  test("viewOf on signed records, growing through one cache", () => {
    const signed = signScenario(bigMesh({ records: 96, revokes: 3, seed: 5 })).records;
    const cache: ViewCache = new Map();
    for (const n of [1, 12, 40, 41, 70, 96]) {
      const part = signed.slice(0, n);
      expect(shape(viewOf(part, cache))).toBe(shape(legacyViewOf(part)));
    }
    expect(shape(viewOf(signed.toReversed()))).toBe(shape(legacyViewOf(signed.toReversed())));
  });
});
