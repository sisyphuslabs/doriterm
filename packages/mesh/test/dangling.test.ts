import { describe, expect, test } from "bun:test";
import { base64urlEncode } from "@doriface/crypto";
import { mergeAtDoor } from "../src/dangling.ts";
import { door } from "../src/door.ts";
import { hashOf, meshIdOf, signRecord } from "../src/records/codec.ts";
import { MAX_DANGLING, MAX_RECORDS, type Signed } from "../src/records/types.ts";
import { ack, admit, found, withChainNumbers } from "./fixtures/records.ts";
import { keyOf, signScenario } from "./fixtures/signed.ts";

// A founds, admits B, then C; B and C each ack. Records are taken by id from one signed history.
const history = signScenario(
  withChainNumbers([
    found("F", "A"),
    admit("aB", "A", "B", ["F"]),
    ack("kB", "B", ["aB"]),
    admit("aC", "A", "C", ["kB"]),
    ack("kC", "C", ["aC"]),
  ]),
);
const rec = (id: string): Signed => {
  const r = history.byId.get(id);
  if (r === undefined) throw new RangeError(id);
  return r;
};
const hashes = (records: readonly Signed[]): string[] => records.map(hashOf);
const A = keyOf("A");
const MESH = meshIdOf(rec("F"));
const ghost = (i: number): string =>
  base64urlEncode(new Uint8Array(32).fill(i % 256).map((b, j) => (j === 0 ? i >> 8 : b)));

describe("design section 3.3 steps 4-5: the dangling pool", () => {
  test("door holds a record whose signer is not admitted yet, and still refuses a bad one", () => {
    expect(door(rec("kB"), [rec("F")])).toEqual({ ok: false, held: true, reason: "unknown signer" });
    expect(door(rec("kB"), [rec("F"), rec("aB")])).toEqual({ ok: true });
    expect(door({ ...rec("kB"), sig: rec("aB").sig }, [rec("F")])).toEqual({
      ok: false,
      held: false,
      reason: "bad signature",
    });
  });

  test("a record of an unknown signer waits, and joins the set when its signer's admit arrives", () => {
    const first = mergeAtDoor([rec("F")], [], [rec("kB")]);
    expect(first.added).toEqual([]);
    expect(first.refused).toEqual([]);
    expect(hashes(first.dangling)).toEqual(hashes([rec("kB")]));
    const second = mergeAtDoor(first.stored, first.dangling, [rec("aB")]);
    expect(hashes(second.added)).toEqual(hashes([rec("aB"), rec("kB")]));
    expect(second.dangling).toEqual([]);
  });

  test("one batch in reverse order is admitted completely: missing pasts and signers are released as they land", () => {
    const merged = mergeAtDoor([rec("F")], [], [rec("kC"), rec("aC"), rec("kB"), rec("aB")]);
    expect(hashes(merged.stored)).toEqual(hashes([rec("F"), rec("aB"), rec("kB"), rec("aC"), rec("kC")]));
    expect(merged.dangling).toEqual([]);
    expect(merged.refused).toEqual([]);
  });

  test("a refused record is not held, and a held record already stored is not added twice", () => {
    const forged = { ...rec("aC"), sig: rec("aB").sig };
    const merged = mergeAtDoor([rec("F"), rec("aB")], [rec("aB")], [forged, rec("aB")]);
    expect(merged.refused).toEqual([{ record: forged, reason: "bad signature" }]);
    expect(merged.added).toEqual([]);
    expect(merged.dangling).toEqual([]);
  });

  test(`the pool holds at most ${MAX_DANGLING} records and drops the oldest first`, () => {
    const waiting = Array.from({ length: MAX_DANGLING + 2 }, (_, i) =>
      signRecord({ v: 2, mesh: MESH, type: "ack", by: A.pub, n: 3 + i, prev: [ghost(i)] }, A.secret),
    );
    const first = mergeAtDoor([rec("F"), rec("aB")], waiting.slice(0, 2), waiting.slice(2));
    expect(first.dangling.length).toBe(MAX_DANGLING);
    expect(hashes(first.dropped)).toEqual(hashes(waiting.slice(0, 2)));
    expect(hashes(first.dangling)).toEqual(hashes(waiting.slice(2)));
  });

  test(`a full log (${MAX_RECORDS} records) refuses new records instead of holding them`, () => {
    const full = [rec("F"), ...Array.from({ length: MAX_RECORDS - 1 }, (_, i) => ({ body: `filler ${i}`, sig: "" }))];
    const merged = mergeAtDoor(full, [], [rec("kB")]);
    expect(merged.refused).toEqual([{ record: rec("kB"), reason: "mesh log full" }]);
    expect(merged.dangling).toEqual([]);
  });
});
