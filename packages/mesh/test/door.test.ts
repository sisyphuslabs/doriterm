import { describe, expect, test } from "bun:test";
import { base64urlEncode } from "@doriface/crypto";
import { door, missingFor } from "../src/door.ts";
import { encodeBody, hashOf, signCard, signRecord } from "../src/records/codec.ts";
import { MAX_RECORDS, type Signed } from "../src/records/types.ts";
import {
  A,
  aB,
  admitOf,
  B,
  C,
  cardBody,
  F,
  MESH,
  noise,
  reason,
  record,
  signRaw,
  stored,
} from "./fixtures/door-set.ts";
import { keyOf } from "./fixtures/signed.ts";

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
      "65 prev (3112 bytes: the size bound comes first; at most 41 prev fit in it)",
      () =>
        reason(
          record({
            type: "ack",
            by: A.pub,
            n: 3,
            prev: Array.from({ length: 65 }, (_, i) => base64urlEncode(new Uint8Array(32).fill(i))),
          }),
        ),
      "too large",
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
    [
      "a signer key of 41 characters",
      () =>
        reason(
          signRaw(encodeBody({ v: 2, mesh: MESH, type: "ack", by: A.pub.slice(0, 41), n: 3, prev: [hashOf(aB)] }), A),
        ),
      "malformed",
    ],
    [
      "a card whose signPub has 41 characters",
      () =>
        reason(
          admitOf(
            signRaw(
              encodeBody({ ...cardBody(C, MESH, A.pub, 3), signPub: C.pub.slice(0, 41) }),
              C,
              "doriface-mesh/1 card",
            ),
            3,
            [hashOf(aB)],
          ),
        ),
      "bad card",
    ],
    ["a record already stored", () => reason(aB), "already stored"],
    [
      `a full log (${MAX_RECORDS} records)`,
      () =>
        reason(record({ type: "ack", by: A.pub, n: 3, prev: [hashOf(aB)] }), [
          ...stored,
          ...Array.from({ length: MAX_RECORDS - 2 }, (_, i) => ({ body: `filler ${i}`, sig: "" })),
        ]),
      "mesh log full",
    ],
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
