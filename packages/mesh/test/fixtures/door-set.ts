// A stored set for the door tests: A founds the mesh and admits B. Records are built from exact bodies, so a test can
// change one field, or sign text the encoder would never produce.

import { base64urlEncode, concatBytes } from "@doriface/crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { door } from "../../src/door.ts";
import { hashOf, meshIdOf, signCard, signRecord } from "../../src/records/codec.ts";
import type { CardBody, RecordBody, Signed } from "../../src/records/types.ts";
import { keyOf, type TestKey } from "./signed.ts";

export const A = keyOf("A");
export const B = keyOf("B");
export const C = keyOf("C");
export const nonce = (i: number): string => base64urlEncode(new Uint8Array(16).fill(i));
export const noise = (i: number): string => base64urlEncode(new Uint8Array(32).fill(i));

export function cardBody(k: TestKey, mesh: string, inviter: string, i: number, name = k.name.toLowerCase()): CardBody {
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

/** Signs exact body text, as the contract specifies: Ed25519 over the prefix || SHA-256(body). */
export function signRaw(body: string, k: TestKey, prefix = "doriface-mesh/1"): Signed {
  const message = concatBytes(new TextEncoder().encode(prefix), sha256(new TextEncoder().encode(body)));
  return { body, sig: base64urlEncode(ed25519.sign(message, k.secret)) };
}

export const F = signRecord(
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
export const MESH = meshIdOf(F);
export const admitOf = (card: Signed, n = 2, prev = [hashOf(F)]): Signed =>
  signRecord({ v: 2, mesh: MESH, type: "admit", by: A.pub, n, prev, subject: { card } }, A.secret);
export const aB = admitOf(signCard(cardBody(B, MESH, A.pub, 2), B.secret));
export const stored: readonly Signed[] = [F, aB];
export const record = (body: Omit<RecordBody, "v" | "mesh">, k: TestKey = A): Signed =>
  signRecord({ v: 2, mesh: MESH, ...body }, k.secret);
export const reason = (r: Signed, set: readonly Signed[] = stored): string | undefined => {
  const result = door(r, set);
  return result.ok ? undefined : result.reason;
};
