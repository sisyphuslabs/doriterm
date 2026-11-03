import { expect, test } from "bun:test";
import { base64urlEncode } from "@doriface/crypto";
import { door } from "../src/door.ts";
import { hashOf, meshIdOf, parseRecord, signCard, signRecord, verifies } from "../src/records/codec.ts";
import { MAX_MESH_MEMBERS, MAX_RECORDS, type Signed } from "../src/records/types.ts";
import { keyOf } from "./fixtures/signed.ts";

/**
 * The door's budget is a multiple of the work it cannot avoid: parsing each record once and verifying its signature
 * once, timed in the same process so a slow or loaded runner moves both sides together. Measured (4096 records,
 * a heavily loaded development machine): the incremental door ran at 0.8-1.09x that floor, 4.66x in the worst load spike;
 * the previous per-call re-index ran at 9-33x already at 1024 records, and grows with the set size.
 */
const BUDGET_PER_FLOOR = 8;

function welcome(): readonly Signed[] {
  const keys = Array.from({ length: MAX_MESH_MEMBERS }, (_, i) => keyOf(`perf${i}`));
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
    const signer = i < MAX_MESH_MEMBERS ? 0 : i % MAX_MESH_MEMBERS;
    const n = (counters.get(signer) ?? 0) + 1;
    counters.set(signer, n);
    const prev = [hashOf(out.at(-1) ?? found)];
    const k = at(signer);
    out.push(
      i < MAX_MESH_MEMBERS
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
