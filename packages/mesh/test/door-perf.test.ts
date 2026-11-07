import { expect, spyOn, test } from "bun:test";
import { base64urlEncode } from "@doriface/crypto";
import { mergeAtDoor } from "../src/dangling.ts";
import { door, holds } from "../src/door.ts";
import * as codec from "../src/records/codec.ts";
import { hashOf, meshIdOf, parseRecord, signCard, signRecord, verifies } from "../src/records/codec.ts";
import { MAX_RECORDS, type Signed } from "../src/records/types.ts";
import { keyOf } from "./fixtures/signed.ts";

/**
 * The door's budget is a multiple of the work it cannot avoid: parsing each record once and verifying its signature
 * once, timed in the same process so a slow or loaded runner moves both sides together. Measured (4096 records,
 * a heavily loaded development machine): the incremental door ran at 0.8-1.09x that floor, 4.66x in the worst load spike;
 * the previous per-call re-index ran at 9-33x already at 1024 records and 65x at 4096. The budget leaves 3.4x over the
 * worst spike, so a contended runner does not fail it, and stays 4x under the quadratic door it exists to catch.
 */
const BUDGET_PER_FLOOR = 16;
/** The welcome's members: they admit each other first, then write acks. */
const MEMBERS = 12;

function welcome(): readonly Signed[] {
  const keys = Array.from({ length: MEMBERS }, (_, i) => keyOf(`perf${i}`));
  const at = (i: number) => keys[i] ?? keys[0] ?? keyOf("perf0");
  const card = (i: number, mesh: string, inviter: string): Signed => {
    const k = at(i);
    const nonce = base64urlEncode(new Uint8Array(16).fill(i + 1));
    const noisePub = base64urlEncode(new Uint8Array(32).fill(i + 1));
    return signCard(
      { v: 1, mesh, inviter, nonce, hostId: k.hostId, signPub: k.pub, noisePub, name: `perf${i}`, hcId: `c${i}` },
      k.secret,
    );
  };
  const founder = at(0);
  const found = signRecord(
    { v: 2, mesh: "-", type: "found", by: founder.pub, n: 1, prev: [], subject: { card: card(0, "-", "-") } },
    founder.secret,
  );
  const mesh = meshIdOf(found);
  const out: Signed[] = [found];
  const counters = new Map<number, number>([[0, 1]]);
  for (let i = 1; out.length < MAX_RECORDS; i++) {
    const signer = i < MEMBERS ? 0 : i % MEMBERS;
    const n = (counters.get(signer) ?? 0) + 1;
    counters.set(signer, n);
    const prev = [hashOf(out.at(-1) ?? found)];
    const k = at(signer);
    out.push(
      i < MEMBERS
        ? signRecord(
            { v: 2, mesh, type: "admit", by: k.pub, n, prev, subject: { card: card(i, mesh, k.pub) } },
            k.secret,
          )
        : signRecord({ v: 2, mesh, type: "ack", by: k.pub, n, prev }, k.secret),
    );
  }
  return out;
}

const timed = (run: () => void): number => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

test("M-14 (door): a 4096-record welcome through the door costs a bounded multiple of verifying each record once", () => {
  const records = welcome();
  const floor = (): void => {
    for (const r of records) {
      const body = parseRecord(r);
      if (body === undefined || !verifies("record", r, body.by)) throw new Error("fixture record does not verify");
    }
  };
  const through = (): void => {
    const stored: Signed[] = [];
    for (const r of records) {
      const result = door(r, stored);
      if (!result.ok) throw new Error(`door refused a welcome record: ${result.reason}`);
      stored.push(r);
    }
  };
  const floorMs = Math.min(timed(floor), timed(floor));
  const doorMs = Math.min(timed(through), timed(through));
  console.log(`door: ${records.length} records in ${doorMs.toFixed(0)} ms; floor ${floorMs.toFixed(0)} ms`);
  expect(records.length).toBe(MAX_RECORDS);
  expect(doorMs).toBeLessThan(BUDGET_PER_FLOOR * floorMs);
}, 300_000);

/** How many of `stored` the codec reads while `run` runs: parsed, hashed or signature-checked, plus every card check. */
function readsOf(stored: readonly Signed[], run: () => void): { records: number; cards: number } {
  const set = new Set<Signed>(stored);
  const reads = [spyOn(codec, "parseRecord"), spyOn(codec, "hashOf")];
  const verified = spyOn(codec, "verifies");
  const cards = spyOn(codec, "verifyCard");
  try {
    run();
    const touched = [...reads.flatMap((s) => s.mock.calls.map(([r]) => r)), ...verified.mock.calls.map(([, r]) => r)];
    return { records: new Set(touched.filter((r) => set.has(r))).size, cards: cards.mock.calls.length };
  } finally {
    for (const spy of [...reads, verified, cards]) spy.mockRestore();
  }
}

/**
 * Counted, not timed (#521): a merge of one record is one signature check whatever the stored set's size, about 0.5 ms,
 * and a few milliseconds of wall time is what a loaded runner moves most (merge p90 3.0 ms, p99 10.6 ms at load5 84),
 * so a timing ratio flipped under load while the merge read nothing. The work M-14 rules out is reading the stored set
 * again, and that is counted exactly: a set the door has indexed is read zero times by a merge, at any size.
 */
test("M-14 (door): a merge into a set the door has indexed re-reads none of it", () => {
  const records = welcome();
  const last = records.at(-1);
  if (last === undefined) throw new Error("empty welcome");
  const mergeInto = (size: number) => {
    const indexed = mergeAtDoor([], [], records.slice(0, size)).stored;
    const next = records[size];
    if (next === undefined) throw new Error("welcome too short");
    // The merge that built `indexed` appended its last record after its last door call; the door indexes that one on
    // its next call. Make that call here, so the set is wholly indexed when the counted merge starts.
    holds(indexed, next);
    const merge = readsOf(indexed, () => {
      if (mergeAtDoor(indexed, [], [next]).added.length !== 1) throw new Error("the next welcome record was not added");
    });
    // The control: a fresh index of the same set is a first read of all of it, so the counter sees the door's reads.
    const fresh = readsOf(indexed, () => door(next, [...indexed]));
    return { size: indexed.length, merge, fresh };
  };
  const small = mergeInto(MAX_RECORDS / 4 - 1);
  const full = mergeInto(MAX_RECORDS - 1);
  console.log(`merge reads ${JSON.stringify([small, full])}`);
  expect(full.size).toBe(MAX_RECORDS - 1);
  expect(full.fresh.records).toBe(full.size);
  expect(small.fresh.records).toBe(small.size);
  expect([small.merge, full.merge]).toEqual([
    { records: 0, cards: 0 },
    { records: 0, cards: 0 },
  ]);
}, 300_000);
