import { describe, expect, test } from "bun:test";
import { base64urlEncode, concatBytes } from "@doriface/crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { door, missingFor } from "../src/door.ts";
import { encodeBody, hashOf, meshIdOf, signCard, signRecord } from "../src/records/codec.ts";
import type { CardBody, RecordBody, Signed } from "../src/records/types.ts";
import { keyOf, type TestKey } from "./fixtures/signed.ts";

const A = keyOf("A");
const B = keyOf("B");
const C = keyOf("C");
const nonce = (i: number): string => base64urlEncode(new Uint8Array(16).fill(i));
const noise = (i: number): string => base64urlEncode(new Uint8Array(32).fill(i));

function cardBody(k: TestKey, mesh: string, inviter: string, i: number, name = k.name.toLowerCase()): CardBody {
  return {
    v: 1,
    mesh,
    inviter,
    nonce: nonce(i),
    hostId: k.hostId,
    signPub: k.pub,
    noisePub: noise(i),
    name,
    hcId: `core-${i}`,
  };
}

/** Signs exact body text, as the contract specifies: Ed25519 over "doriface-mesh/1" || SHA-256(body). */
function signRaw(body: string, k: TestKey): Signed {
  const message = concatBytes(new TextEncoder().encode("doriface-mesh/1"), sha256(new TextEncoder().encode(body)));
  return { body, sig: base64urlEncode(ed25519.sign(message, k.secret)) };
}

const F = signRecord(
  {
    v: 2,
    mesh: "-",
    type: "found",
    by: A.pub,
    n: 1,
    prev: [],
    subject: { card: signCard(cardBody(A, "-", "-", 1), A.secret) },
  },
  A.secret,
);
const MESH = meshIdOf(F);
const admitOf = (card: Signed, n = 2, prev = [hashOf(F)]): Signed =>
  signRecord({ v: 2, mesh: MESH, type: "admit", by: A.pub, n, prev, subject: { card } }, A.secret);
const aB = admitOf(signCard(cardBody(B, MESH, A.pub, 2), B.secret));
const stored: readonly Signed[] = [F, aB];
const record = (body: Omit<RecordBody, "v" | "mesh">, k: TestKey = A): Signed =>
  signRecord({ v: 2, mesh: MESH, ...body }, k.secret);
const reason = (r: Signed, set: readonly Signed[] = stored): string | undefined => {
  const result = door(r, set);
  return result.ok ? undefined : result.reason;
};

describe("M-2: the door refuses each rule of design section 3.3", () => {
  test("a found into an empty set and an admit with a fresh card are let in", () => {
    expect(door(F, [])).toEqual({ ok: true });
    expect(door(aB, [F])).toEqual({ ok: true });
  });

  const cases: readonly (readonly [string, () => string | undefined, string])[] = [
    [
      "a signature by another key",
      () => reason({ ...record({ type: "ack", by: A.pub, n: 3, prev: [hashOf(aB)] }), sig: aB.sig }),
      "bad signature",
    ],
    [
      "a card signed by the inviter, not its subject",
      () => reason(admitOf(signCard(cardBody(C, MESH, A.pub, 3), A.secret), 3, [hashOf(aB)])),
      "bad card",
    ],
    [
      "a card naming another inviter",
      () => reason(admitOf(signCard(cardBody(C, MESH, B.pub, 3), C.secret), 3, [hashOf(aB)])),
      "card inviter mismatch",
    ],
    [
      "a card bound to another mesh",
      () => reason(admitOf(signCard(cardBody(C, "x".repeat(26), A.pub, 3), C.secret), 3, [hashOf(aB)])),
      "bad card",
    ],
    [
      "a reused card nonce",
      () => reason(admitOf(signCard(cardBody(C, MESH, A.pub, 2), C.secret), 3, [hashOf(aB)])),
      "card nonce reused",
    ],
    [
      "an unknown signer",
      () => reason(record({ type: "ack", by: C.pub, n: 1, prev: [hashOf(aB)] }, C)),
      "unknown signer",
    ],
    [
      "a missing prev (dangling)",
      () => reason(record({ type: "ack", by: A.pub, n: 3, prev: [noise(99)] })),
      "dangling",
    ],
    [
      "65 prev",
      () =>
        reason(
          record({
            type: "ack",
            by: A.pub,
            n: 3,
            prev: Array.from({ length: 65 }, (_, i) => base64urlEncode(new Uint8Array(32).fill(i))),
          }),
        ),
      "malformed",
    ],
    [
      "17 revoke subjects",
      () =>
        reason(
          record({
            type: "revoke",
            by: A.pub,
            n: 3,
            prev: [hashOf(aB)],
            subject: { signPubs: Array.from({ length: 17 }, (_, i) => keyOf(`k${i}`).pub), reason: "revoke" },
          }),
        ),
      "malformed",
    ],
    [
      "a duplicate JSON member",
      () =>
        reason(
          signRaw(
            encodeBody({ v: 2, mesh: MESH, type: "ack", by: A.pub, n: 3, prev: [hashOf(aB)] }).replace(
              '"n":3',
              '"n":3,"n":4',
            ),
            A,
          ),
        ),
      "malformed",
    ],
    [
      "an unsafe integer",
      () =>
        reason(
          signRaw(
            encodeBody({ v: 2, mesh: MESH, type: "ack", by: A.pub, n: 3, prev: [hashOf(aB)] }).replace(
              '"n":3',
              '"n":9007199254740993',
            ),
            A,
          ),
        ),
      "malformed",
    ],
    [
      "a name failing herdr's rule",
      () =>
        reason(record({ type: "name", by: A.pub, n: 3, prev: [hashOf(aB)], subject: { signPub: B.pub, name: "t7" } })),
      "malformed",
    ],
    [
      "a record of another mesh",
      () =>
        reason(signRecord({ v: 2, mesh: "x".repeat(26), type: "ack", by: A.pub, n: 3, prev: [hashOf(aB)] }, A.secret)),
      "another mesh",
    ],
    [
      "a second found",
      () =>
        reason(
          signRecord(
            {
              v: 2,
              mesh: "-",
              type: "found",
              by: B.pub,
              n: 1,
              prev: [],
              subject: { card: signCard(cardBody(B, "-", "-", 9), B.secret) },
            },
            B.secret,
          ),
        ),
      "a second found",
    ],
    [
      "a rekey of another member",
      () =>
        reason(
          record({
            type: "rekey",
            by: A.pub,
            n: 3,
            prev: [hashOf(aB)],
            subject: { card: signCard(cardBody(B, MESH, B.pub, 9), B.secret) },
          }),
        ),
      "rekey of another member",
    ],
    ["a record already stored", () => reason(aB), "already stored"],
    [
      "a body over 2048 bytes",
      () =>
        reason(
          signRaw(
            encodeBody({ v: 2, mesh: MESH, type: "ack", by: A.pub, n: 3, prev: [hashOf(aB)], at: "x".repeat(2100) }),
            A,
          ),
        ),
      "too large",
    ],
  ];
  for (const [what, run, want] of cases) test(`${what}: ${want}`, () => expect(run()).toBe(want));

  test("the stored index follows the array: appended records count, a shrunk or different array is re-read", () => {
    const ack = record({ type: "ack", by: A.pub, n: 3, prev: [hashOf(aB)] });
    const growing: Signed[] = [F];
    expect(reason(ack, growing)).toBe("dangling");
    growing.push(aB);
    expect(reason(ack, growing)).toBeUndefined();
    growing.push(ack);
    expect(reason(ack, growing)).toBe("already stored");
    growing.length = 2;
    expect(reason(ack, growing)).toBeUndefined();
    expect(reason(ack, [F])).toBe("dangling");
  });

  test("missingFor names exactly the prev hashes the set lacks", () => {
    const ghost = base64urlEncode(new Uint8Array(32).fill(7));
    expect(missingFor(record({ type: "ack", by: A.pub, n: 3, prev: [hashOf(aB), ghost] }), stored)).toEqual([ghost]);
  });
});
