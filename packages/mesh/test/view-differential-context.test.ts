import { describe, expect, test } from "bun:test";
import type { Rec } from "../src/view/dag.ts";
import { ViewCache } from "../src/view/engine.ts";
import { readmitDag } from "./fixtures/readmit-dag.ts";
import { pastClosed, SEEDS, same, sameEverywhere } from "./oracle/differential.ts";
import { honestHistory, pick, type Rng, rng } from "./sim/world.ts";

const SLOW = 120_000;

const someHistory = (r: Rng): readonly Rec[] =>
  r.next() < 0.7
    ? readmitDag(r, 24 + Math.floor(r.next() * 32))
    : honestHistory(r, 12 + Math.floor(r.next() * 10)).records;

describe("M-14: views whose conflicts are decided by ack testimony equal the oracle", () => {
  test(
    "re-admission histories: the full view and view(past(x)) for every record",
    () => {
      for (const seed of SEEDS) {
        const r = rng(seed + 2000);
        for (let i = 0; i < 16; i++) expect(sameEverywhere(readmitDag(r, 20 + Math.floor(r.next() * 36)))).toBe(true);
      }
    },
    SLOW,
  );

  test(
    "every record's closed past, then random past-closed unions, through one cache: each equals a fresh evaluation",
    () => {
      for (const seed of SEEDS) {
        const r = rng(seed + 3000);
        for (let i = 0; i < 6; i++) {
          const records = someHistory(r);
          const ids = records.map((x) => x.id);
          const cache = new ViewCache();
          for (const id of ids) expect(same(pastClosed(records, [id]), cache)).toBe(true);
          for (let k = 0; k < 14; k++) {
            const roots = Array.from({ length: 1 + Math.floor(r.next() * 3) }, () => pick(r, ids));
            expect(same(pastClosed(records, roots), cache)).toBe(true);
          }
          expect(same(records, cache)).toBe(true);
        }
      }
    },
    SLOW,
  );
});
