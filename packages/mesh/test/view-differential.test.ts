import { describe, expect, test } from "bun:test";
import { Dag } from "../src/view/dag.ts";
import { Engine, ViewCache, viewOf, viewOfRecords } from "../src/view/engine.ts";
import { bigMesh } from "./fixtures/big-mesh.ts";
import { randomDag } from "./fixtures/random-dag.ts";
import { ack, admit, found, name, revoke, withChainNumbers } from "./fixtures/records.ts";
import { SCENARIOS, stored } from "./fixtures/scenarios-all.ts";
import { signScenario } from "./fixtures/signed.ts";
import { SEEDS, same, sameEverywhere, shape } from "./oracle/differential.ts";
import { viewOf as legacyViewOf } from "./oracle/legacy/engine.ts";
import { naiveView } from "./oracle/naive.ts";
import { attack, honestHistory, pick, rng } from "./sim/world.ts";

const SLOW = 120_000;

const sorted = (keys: Iterable<string>): string[] => [...keys].toSorted();
/** The part of a view the naive oracle also computes: members, revoked and Noise keys, order-free. */
const lite = (v: { members: Iterable<string>; revoked: Iterable<string>; noise: Iterable<[string, string]> }): string =>
  JSON.stringify([sorted(v.members), sorted(v.revoked), [...v.noise].toSorted()]);

describe("M-14: the incremental viewOf is byte-identical to the previous engine (the oracle)", () => {
  test(
    "seeded adversarial histories (honest writers, then a revoked key's backdated records)",
    () => {
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
        }
      }
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

  test(
    "arbitrary DAGs whose admits and rekeys reuse other subjects' Noise keys: engine, legacy and naive agree (#90 R1)",
    () => {
      let twins = 0;
      for (const seed of SEEDS) {
        const r = rng(seed + 2000);
        for (let i = 0; i < 60; i++) {
          const records = randomDag(r, 8 + Math.floor(r.next() * 8));
          const subjects = new Map<string, Set<string>>();
          for (const x of records)
            if (x.card !== undefined && x.subject !== undefined)
              subjects.set(x.card.noise, (subjects.get(x.card.noise) ?? new Set()).add(x.subject));
          if ([...subjects.values()].some((named) => named.size > 1)) twins += 1;
          expect(sameEverywhere(records)).toBe(true);
          expect(lite(viewOfRecords(records))).toBe(lite(naiveView(records)));
        }
      }
      // The generator reaches R1: some cases name one Noise key for two subjects.
      expect(twins).toBeGreaterThan(0);
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
    expect(e.pastView("x1")?.eff.has("y")).toBe(false);
    expect(e.pastView("x2")?.eff.has("y")).toBe(true);
  });

  test("P1-P13, R1-R5b, A1-A21 and the merged self-forks SF1, SF1b and SF2", () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual(expect.arrayContaining(["P13", "R5b", "A21", "SF1", "SF1b", "SF2"]));
    for (const s of SCENARIOS) expect([s.id, sameEverywhere(stored(s))]).toEqual([s.id, true]);
  });

  test("one cache through every scenario: abstract ids reused across DAGs never reach a stale view", () => {
    const cache = new ViewCache();
    for (const s of SCENARIOS) expect([s.id, same(stored(s), cache)]).toEqual([s.id, true]);
  });

  test(
    "large meshes, past twelve members too, with revokes concurrent with acks and with names",
    () => {
      for (const seed of SEEDS.slice(0, 4))
        for (const records of [64, 160])
          for (const members of [12, 24]) {
            const mesh = bigMesh({ records, revokes: records / 32, seed, forks: 0.2, members });
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
        const cache = new ViewCache();
        for (let n = 2; n <= mesh.length; n += 9) expect(same(mesh.slice(0, n), cache)).toBe(true);
        expect(same(mesh, cache)).toBe(true);
        expect(same(mesh.slice(0, 40), cache)).toBe(true);
      }
      const r = rng(77);
      for (let i = 0; i < 30; i++) {
        const w = honestHistory(r, 16);
        const cache = new ViewCache();
        for (const ids of w.know.values()) expect(same(w.subset(ids), cache)).toBe(true);
        expect(same(w.records, cache)).toBe(true);
      }
    },
    SLOW,
  );

  test("viewOf on signed records, growing through one cache", () => {
    const signed = signScenario(bigMesh({ records: 96, revokes: 3, seed: 5 })).records;
    const cache = new ViewCache();
    for (const n of [1, 12, 40, 41, 70, 96]) {
      const part = signed.slice(0, n);
      expect(shape(viewOf(part, cache))).toBe(shape(legacyViewOf(part)));
    }
    expect(shape(viewOf(signed.toReversed()))).toBe(shape(legacyViewOf(signed.toReversed())));
  });
});
