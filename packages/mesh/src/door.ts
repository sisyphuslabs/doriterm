// The door (contract v1.5 "Records"; design section 3.3): the checks a record passes before it is stored. They need
// no view, only the record and the stored set.

import {
  cardOf,
  fitsBody,
  hashOf,
  isSignature,
  isSigned,
  meshIdOf,
  parseRecord,
  verifies,
  verifyCard,
} from "./records/codec.ts";
import { MAX_RECORDS, type RecordBody, type Signed } from "./records/types.ts";

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

/** Reasons that hold a record in the dangling pool (design section 3.3 steps 4-5) instead of refusing it. */
export type HoldReason = Extract<DoorReason, "dangling" | "unknown signer">;
export type RefusalReason = Exclude<DoorReason, HoldReason>;

export type DoorResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly held: true; readonly reason: HoldReason }
  | { readonly ok: false; readonly held: false; readonly reason: RefusalReason };

const OK: DoorResult = { ok: true };
const refuse = (reason: RefusalReason): DoorResult => ({ ok: false, held: false, reason });
const hold = (reason: HoldReason): DoorResult => ({ ok: false, held: true, reason });

/** What the door needs from the stored set, built once per stored array and extended as the array grows. */
interface StoredIndex {
  readonly hashes: Set<string>;
  readonly signers: Set<string>;
  readonly nonces: Set<string>;
  meshId: string | undefined;
  /** The array elements already indexed, to tell an append (index only the new tail) from a different set. */
  count: number;
  first: Signed | undefined;
  last: Signed | undefined;
}

const indexes = new WeakMap<readonly Signed[], StoredIndex>();

function add(index: StoredIndex, record: Signed): void {
  index.hashes.add(hashOf(record));
  const body = parseRecord(record);
  if (body === undefined) return;
  if (body.type === "found") index.meshId = meshIdOf(record);
  const raw = cardOf(body);
  const card = raw === undefined ? undefined : verifyCard(raw);
  if (card === undefined) return;
  index.nonces.add(card.nonce);
  if (body.type !== "rekey") index.signers.add(card.signPub);
}

/**
 * The index of `stored`. A stored set only grows, so a call with the same array as before indexes just the records
 * appended since; a different array (or one whose indexed prefix changed) is indexed from scratch, once.
 */
function indexOf(stored: readonly Signed[]): StoredIndex {
  let index = indexes.get(stored);
  const reused =
    index !== undefined &&
    index.count <= stored.length &&
    (index.count === 0 || (stored[0] === index.first && stored[index.count - 1] === index.last));
  if (index === undefined || !reused) {
    index = {
      hashes: new Set(),
      signers: new Set(),
      nonces: new Set(),
      meshId: undefined,
      count: 0,
      first: undefined,
      last: undefined,
    };
    indexes.set(stored, index);
  }
  for (let i = index.count; i < stored.length; i++) {
    const record = stored[i];
    if (record !== undefined) add(index, record);
  }
  index.count = stored.length;
  index.first = stored[0];
  index.last = stored.at(-1);
  return index;
}

/** The prev hashes of `record` that `stored` does not hold (a record with any is dangling and waits). */
export function missingFor(record: Signed, stored: readonly Signed[]): readonly string[] {
  const { hashes } = indexOf(stored);
  return (parseRecord(record)?.prev ?? []).filter((hash) => !hashes.has(hash));
}

function cardCheck(body: RecordBody, meshId: string, nonces: ReadonlySet<string>): DoorResult {
  if (body.type !== "found" && body.type !== "admit" && body.type !== "rekey") return OK;
  const raw = cardOf(body);
  const card = raw === undefined ? undefined : verifyCard(raw);
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

/** The size and the signature's shape are checked before the body is parsed, so an oversize record costs nothing. */
export function door(record: Signed, stored: readonly Signed[]): DoorResult {
  if (!isSigned(record)) return refuse("malformed");
  if (!fitsBody(record.body)) return refuse("too large");
  if (!isSignature(record.sig)) return refuse("bad signature");
  const body = parseRecord(record);
  if (body === undefined) return refuse("malformed");
  if (!verifies("record", record, body.by)) return refuse("bad signature");
  const set = indexOf(stored);
  if (set.hashes.has(hashOf(record))) return refuse("already stored");
  if (set.hashes.size >= MAX_RECORDS) return refuse("mesh log full");
  if (body.type === "found") {
    if (set.meshId !== undefined) return refuse("a second found");
    return body.mesh === "-" ? cardCheck(body, "-", set.nonces) : refuse("another mesh");
  }
  if (set.meshId === undefined || body.mesh !== set.meshId) return refuse("another mesh");
  if (!set.signers.has(body.by)) return hold("unknown signer");
  if (body.prev.some((hash) => !set.hashes.has(hash))) return hold("dangling");
  return cardCheck(body, body.mesh, set.nonces);
}
