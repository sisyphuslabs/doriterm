import { describe, expect, test } from "bun:test";
import { mergeAtDoor } from "../src/dangling.ts";
import { door, missingFor } from "../src/door.ts";
import { encodeBody, hashOf, parseRecord, verifyCard } from "../src/records/codec.ts";
import { MAX_BODY_BYTES, type Signed } from "../src/records/types.ts";
import { canonicalOrder } from "../src/view/canonical.ts";
import { viewOf } from "../src/view/engine.ts";
import { A, aB, admitOf, C, cardBody, MESH, record, signRaw, stored } from "./fixtures/door-set.ts";

const CARD_PREFIX = "doriface-mesh/1 card";
const ack = record({ type: "ack", by: A.pub, n: 3, prev: [hashOf(aB)] });
const ackBody = { v: 2, mesh: MESH, type: "ack", by: A.pub, n: 3, prev: [hashOf(aB)] } as const;
const fromWire = (json: string): Signed => JSON.parse(json);

/** Wrong spellings of a canonical base64url value: lengths off by 1-2 and those 1 mod 4 (the decoder throws on them),
 * padding, a character outside the alphabet, and non-zero trailing bits (a second spelling of the same bytes). */
function spellings(value: string): readonly string[] {
  const n = value.length;
  const lengths = [0, 1, 5, n - 2, n - 1, n + 1, n + 2, n - ((n - 1) % 4) - 4, n - ((n - 1) % 4) + 4];
  const sized = lengths.filter((l) => l >= 0).map((l) => (l <= n ? value.slice(0, l) : value + "A".repeat(l - n)));
  return [...sized, `${value}=`, `+${value.slice(1)}`, `${value.slice(0, -1)}B`];
}

interface Field {
  readonly name: string;
  readonly build: (bad: string) => Signed;
  readonly reason: "malformed" | "bad signature" | "bad card";
  readonly value: string;
}

const card = (field: string, bad: string): Signed =>
  admitOf(signRaw(encodeBody({ ...cardBody(C, MESH, A.pub, 3), [field]: bad }), C, CARD_PREFIX), 3, [hashOf(aB)]);
const cCard = signRaw(encodeBody(cardBody(C, MESH, A.pub, 3)), C, CARD_PREFIX);
const cardWithSig = (bad: string): Signed => admitOf({ ...cCard, sig: bad }, 3, [hashOf(aB)]);

const fields: readonly Field[] = [
  { name: "by", build: (b) => signRaw(encodeBody({ ...ackBody, by: b }), A), reason: "malformed", value: A.pub },
  {
    name: "prev",
    build: (b) => signRaw(encodeBody({ ...ackBody, prev: [b] }), A),
    reason: "malformed",
    value: hashOf(aB),
  },
  {
    name: "revoke subject",
    build: (b) =>
      record({ type: "revoke", by: A.pub, n: 3, prev: [hashOf(aB)], subject: { signPubs: [b], reason: "revoke" } }),
    reason: "malformed",
    value: C.pub,
  },
  {
    name: "name subject",
    build: (b) => record({ type: "name", by: A.pub, n: 3, prev: [hashOf(aB)], subject: { signPub: b, name: "box" } }),
    reason: "malformed",
    value: C.pub,
  },
  { name: "record sig", build: (b) => ({ ...ack, sig: b }), reason: "bad signature", value: ack.sig },
  { name: "card signPub", build: (b) => card("signPub", b), reason: "bad card", value: C.pub },
  { name: "card noisePub", build: (b) => card("noisePub", b), reason: "bad card", value: C.pub },
  { name: "card devicePub", build: (b) => card("devicePub", b), reason: "bad card", value: C.pub },
  { name: "card nonce", build: (b) => card("nonce", b), reason: "bad card", value: cardBody(C, MESH, A.pub, 3).nonce },
  { name: "card sig", build: cardWithSig, reason: "bad card", value: cCard.sig },
];

describe("M-2: a malformed key, hash, nonce or signature is refused at every entry point, never thrown", () => {
  for (const field of fields) {
    test(`${field.name}: the canonical spelling is let in, every wrong one -> ${field.reason}`, () => {
      expect(door(field.build(field.value), stored)).toEqual({ ok: true });
      for (const bad of spellings(field.value)) {
        const x = field.build(bad);
        expect(door(x, stored)).toEqual({ ok: false, held: false, reason: field.reason });
        if (field.reason === "malformed") expect(parseRecord(x)).toBeUndefined();
        const raw = parseRecord(x)?.subject;
        if (field.reason === "bad card" && raw !== undefined && "card" in raw)
          expect(verifyCard(raw.card)).toBeUndefined();
        expect(missingFor(x, stored)).toEqual([]);
        expect(canonicalOrder([...stored, x]).length).toBe(3);
        if (field.reason !== "bad signature") expect(viewOf([...stored, x]).eff.has(hashOf(x))).toBe(false);
        const merged = mergeAtDoor(stored, [], [x, ack]);
        expect([merged.refused.map((r) => r.reason), merged.added]).toEqual([[field.reason], [ack]]);
      }
    });
  }
});

describe("the door bounds its work before it parses (design section 3.3 step 1)", () => {
  test("a body over the limit is too large even when it is not JSON", () => {
    expect(door(signRaw(`{${"x".repeat(MAX_BODY_BYTES)}`, A), stored)).toEqual({
      ok: false,
      held: false,
      reason: "too large",
    });
  });

  test("a signature of the wrong length is refused before the body is read", () => {
    expect(door({ ...ack, sig: "A".repeat(1 << 20) }, stored)).toEqual({
      ok: false,
      held: false,
      reason: "bad signature",
    });
  });

  test("a record whose body or signature is not a string is malformed", () => {
    for (const json of ['{"body":5,"sig":"x"}', '{"body":"{}","sig":null}', '{"body":["x"]}']) {
      const x = fromWire(json);
      expect(door(x, stored)).toEqual({ ok: false, held: false, reason: "malformed" });
      expect(parseRecord(x)).toBeUndefined();
      expect(verifyCard(x)).toBeUndefined();
    }
  });
});
