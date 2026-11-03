import { base64urlEncode, type HostIdentity } from "@doriface/crypto";
import {
  encodeBody,
  hashOf,
  MAX_BODY_BYTES,
  MAX_PREV,
  MAX_RECORDS,
  missingFor,
  parseRecord,
  type RecordBody,
  type RevokeReason,
  type Signed,
  type Subject,
} from "@doriface/mesh";
import { CounterBehindError, type MeshStore, type MeshTx } from "../state/mesh.ts";
import { headsOf } from "../state/mesh-tx.ts";
import { ownHeadFirst } from "./fold.ts";
import { type MeshView, meshViewOf } from "./mesh-view.ts";

export interface MergeDeps {
  readonly store: Pick<MeshStore, "transact" | "read" | "catchUp">;
  readonly identity: HostIdentity;
  readonly meshId: string;
}

export interface Refusal {
  readonly hash: string;
  readonly reason: string;
}

export interface MergeResult {
  /** Records stored by this transaction, in the order stored, this host's own acks included. */
  readonly added: readonly Signed[];
  readonly refused: readonly Refusal[];
  /** Hashes the dangling pool still waits for. */
  readonly wanted: readonly string[];
  /** The ack this merge wrote (section 5.5), if any. */
  readonly ack: Signed | undefined;
  /**
   * This host's stored counter was behind its own records (a restored backup), so it signed nothing (section 10.1);
   * the counter is caught up from the merged records, and the next merge signs.
   */
  readonly counterBehind: boolean;
  readonly view: MeshView;
}

/** A record of this host's own, other than an ack: a revoke (or `mesh leave`'s self-revoke), or a rename. */
export type RecordDraft =
  | { readonly type: "revoke"; readonly signPubs: readonly string[]; readonly reason: RevokeReason }
  | { readonly type: "name"; readonly signPub: string; readonly name: string };

const MEMBERSHIP = new Set(["admit", "revoke", "rekey"]);
const selfOf = (deps: MergeDeps): string => base64urlEncode(deps.identity.sign.publicKey);

function bodyOf(deps: MergeDeps, n: number, prev: readonly string[], draft?: RecordDraft): RecordBody {
  const base = { v: 2, mesh: deps.meshId, by: selfOf(deps), n, prev } as const;
  if (draft === undefined) return { ...base, type: "ack" };
  const subject: Subject =
    draft.type === "revoke"
      ? { signPubs: draft.signPubs, reason: draft.reason }
      : { signPub: draft.signPub, name: draft.name };
  return { ...base, type: draft.type, subject };
}

const encoder = new TextEncoder();
const fits = (body: RecordBody): boolean => encoder.encode(encodeBody(body)).byteLength <= MAX_BODY_BYTES;

/**
 * The most of `heads` one ack can name, from the front: at most MAX_PREV, and few enough that its body stays within
 * 2048 bytes. The caller puts the head covering this host's own latest record first.
 */
function foldable(deps: MergeDeps, n: number, heads: readonly string[]): readonly string[] {
  let count = Math.min(heads.length, MAX_PREV);
  while (count > 1 && !fits(bodyOf(deps, n, heads.slice(0, count)))) count -= 1;
  return heads.slice(0, count);
}

/**
 * Signs acks over subsets of the heads until they all fit one record's `prev` (section 5.2): at most 64 hashes, and
 * a body within 2048 bytes, which holds fewer than 64. False when the log fills first.
 */
function fitHeads(deps: MergeDeps, tx: MeshTx, draft?: RecordDraft): boolean {
  const fitsOne = (heads: readonly string[]): boolean =>
    heads.length <= MAX_PREV && fits(bodyOf(deps, Number.MAX_SAFE_INTEGER, heads, draft));
  while (!fitsOne(headsOf(tx.records))) {
    if (tx.records.length >= MAX_RECORDS) return false;
    tx.sign(deps.identity, (n, prev) =>
      bodyOf(deps, n, foldable(deps, n, ownHeadFirst(tx.records, prev, selfOf(deps)))),
    );
  }
  return tx.records.length < MAX_RECORDS;
}

/** A membership record signed by someone else is acked once, by a member that is valid in the merged view. */
function needsAck(deps: MergeDeps, added: readonly Signed[], view: MeshView): boolean {
  const self = selfOf(deps);
  if (!view.members.some((member) => member.signPub === self)) return false;
  return added.some((record) => {
    const body = parseRecord(record);
    return body !== undefined && body.by !== self && MEMBERSHIP.has(body.type);
  });
}

function wantedBy(tx: MeshTx): readonly string[] {
  const stored = new Set(tx.records.map(hashOf));
  const missing = tx.dangling.flatMap((record) => missingFor(record, tx.records));
  return [...new Set(missing)].filter((hash) => !stored.has(hash));
}

/**
 * Merges a batch in one state transaction (section 5.5): the door and the dangling pool, the view, and the automatic
 * ack signed on the heads after the merge, all written in one generation, so no interleaved merge separates the ack
 * from the batch and nothing is pushed before it is committed.
 */
export function mergeBatch(deps: MergeDeps, batch: readonly Signed[]): MergeResult {
  const result = deps.store.transact((tx) => {
    const before = tx.records.length;
    const merged = tx.merge(batch);
    let view = meshViewOf(tx.records, tx.view());
    let behind = false;
    let ack: Signed | undefined;
    if (needsAck(deps, merged.added, view)) {
      try {
        if (fitHeads(deps, tx)) ack = tx.sign(deps.identity, (n, prev) => bodyOf(deps, n, prev));
      } catch (error) {
        if (!(error instanceof CounterBehindError)) throw error;
        behind = true;
      }
      if (ack !== undefined) view = meshViewOf(tx.records, tx.view());
    }
    const refused = merged.refused.map(({ record, reason }) => ({ hash: hashOf(record), reason }));
    const added = tx.records.slice(before);
    return { added, refused, wanted: wantedBy(tx), ack, counterBehind: behind, view };
  });
  if (result.counterBehind) deps.store.catchUp(deps.identity);
  return result;
}

/** Signs one record of this host's own (a revoke, a leave, a rename) in a transaction, after fitting its heads. */
export function appendOwn(deps: MergeDeps, draft: RecordDraft): MergeResult {
  return deps.store.transact((tx) => {
    const before = tx.records.length;
    if (!fitHeads(deps, tx, draft)) throw new Error(`mesh log full (${MAX_RECORDS})`);
    tx.sign(deps.identity, (n, prev) => bodyOf(deps, n, prev, draft));
    const view = meshViewOf(tx.records, tx.view());
    return { added: tx.records.slice(before), refused: [], wanted: [], ack: undefined, counterBehind: false, view };
  });
}
