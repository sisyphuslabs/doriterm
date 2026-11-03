// The door (contract v1.5 "Records"; design section 3.3): the checks a record passes before it is stored. They need
// no view, only the record and the stored set.

import { bodyBytes, cardOf, hashOf, meshIdOf, parseRecord, verifies, verifyCard } from "./records/codec.ts";
import { type CardBody, MAX_BODY_BYTES, MAX_RECORDS, type RecordBody, type Signed } from "./records/types.ts";

export type DoorReason =
  | "malformed"
  | "too large"
  | "bad signature"
  | "already stored"
  | "mesh log full"
  | "a second found"
  | "another mesh"
  | "unknown signer"
  | "dangling"
  | "bad card"
  | "card inviter mismatch"
  | "rekey of another member"
  | "card nonce reused";

export type DoorResult = { readonly ok: true } | { readonly ok: false; readonly reason: DoorReason };

const OK: DoorResult = { ok: true };
const refuse = (reason: DoorReason): DoorResult => ({ ok: false, reason });

interface Stored {
  readonly hashes: ReadonlySet<string>;
  readonly found: Signed | undefined;
  readonly signers: ReadonlySet<string>;
  readonly nonces: ReadonlySet<string>;
}

function index(stored: readonly Signed[]): Stored {
  const signers = new Set<string>();
  const nonces = new Set<string>();
  let found: Signed | undefined;
  for (const record of stored) {
    const body = parseRecord(record);
    if (body?.type === "found") found = record;
    const card = body === undefined ? undefined : verifiedCardOf(body);
    if (card === undefined || body === undefined) continue;
    nonces.add(card.nonce);
    if (body.type !== "rekey") signers.add(card.signPub);
  }
  return { hashes: new Set(stored.map(hashOf)), found, signers, nonces };
}

const verifiedCardOf = (body: RecordBody): CardBody | undefined => {
  const card = cardOf(body);
  return card === undefined ? undefined : verifyCard(card);
};

/** The prev hashes of `record` that `stored` does not hold (a record with any is dangling and waits). */
export function missingFor(record: Signed, stored: readonly Signed[]): readonly string[] {
  const hashes = new Set(stored.map(hashOf));
  return (parseRecord(record)?.prev ?? []).filter((hash) => !hashes.has(hash));
}

function cardCheck(body: RecordBody, meshId: string, nonces: ReadonlySet<string>): DoorResult {
  if (body.type !== "found" && body.type !== "admit" && body.type !== "rekey") return OK;
  const card = verifiedCardOf(body);
  if (card === undefined || card.mesh !== meshId) return refuse("bad card");
  switch (body.type) {
    case "found":
      return card.signPub === body.by && card.inviter === "-" ? OK : refuse("bad card");
    case "admit":
      if (card.inviter !== body.by) return refuse("card inviter mismatch");
      return nonces.has(card.nonce) ? refuse("card nonce reused") : OK;
    case "rekey":
      return card.signPub === body.by && card.inviter === body.by ? OK : refuse("rekey of another member");
  }
}

export function door(record: Signed, stored: readonly Signed[]): DoorResult {
  const body = parseRecord(record);
  if (body === undefined) return refuse("malformed");
  if (bodyBytes(record) > MAX_BODY_BYTES) return refuse("too large");
  if (!verifies("record", record, body.by)) return refuse("bad signature");
  const set = index(stored);
  if (set.hashes.has(hashOf(record))) return refuse("already stored");
  if (set.hashes.size >= MAX_RECORDS) return refuse("mesh log full");
  if (body.type === "found") {
    if (set.found !== undefined) return refuse("a second found");
    return body.mesh === "-" ? cardCheck(body, "-", set.nonces) : refuse("another mesh");
  }
  if (set.found === undefined || body.mesh !== meshIdOf(set.found)) return refuse("another mesh");
  if (!set.signers.has(body.by)) return refuse("unknown signer");
  if (body.prev.some((hash) => !set.hashes.has(hash))) return refuse("dangling");
  return cardCheck(body, body.mesh, set.nonces);
}
