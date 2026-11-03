/**
 * The parts of `@doriface/mesh` (records, the door and the view: mesh design section 11, PR 2) and of the host's mesh
 * state (`state/mesh.ts`, PR 3) that sync calls, typed as the design specifies them. Sync codes against these
 * interfaces only; when those PRs land, this file becomes re-exports of theirs.
 */

/** A signed record as stored and sent: the exact body bytes the signer produced, and its signature. */
export interface MeshRecord {
  readonly body: string;
  readonly sig: string;
}

export type RecordType = "found" | "admit" | "revoke" | "name" | "rekey" | "ack";

/** The body fields sync reads (section 3.2). */
export interface RecordHeader {
  readonly hash: string;
  readonly type: RecordType;
  /** The signer's signPub. */
  readonly by: string;
  readonly n: number;
  readonly prev: readonly string[];
  /** The keys a `revoke` names; empty for every other type. */
  readonly revokes: readonly string[];
}

export interface MeshMember {
  readonly signPub: string;
  readonly hostId: string;
  readonly noisePub: string;
  /** The mesh name (section 7.4). */
  readonly name: string;
  /** The member's herdr core id, from its card. */
  readonly hcId: string;
}

/** `viewOf`'s answer, reduced to what sync and the reconciler use. */
export interface MeshView {
  /** Current members in canonical order, the cap applied. */
  readonly members: readonly MeshMember[];
  /** Members past the 12th in canonical order. */
  readonly overCap: readonly MeshMember[];
  /** Keys the view revoked. */
  readonly revoked: readonly string[];
}

/** The door's verdict (section 3.3): store it, hold it until its past arrives, or refuse it. */
export type DoorVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "dangling"; readonly missing: readonly string[] }
  | { readonly kind: "refused"; readonly reason: string };

/** `@doriface/mesh` (PR 2). Every function is pure over the record set it is given. */
export interface MeshRules {
  headerOf(record: MeshRecord): RecordHeader;
  door(record: MeshRecord, stored: readonly MeshRecord[]): DoorVerdict;
  viewOf(records: readonly MeshRecord[]): MeshView;
  /** The hashes no stored record names in its `prev`. */
  headsOf(records: readonly MeshRecord[]): readonly string[];
  /** The stored records outside the past of `peerHeads` (unknown heads ignored), in a topological order. */
  missingFor(records: readonly MeshRecord[], peerHeads: readonly string[]): readonly MeshRecord[];
}

/** What `mesh.json` holds that sync reads and writes (section 10.1). */
export interface MeshState {
  readonly records: readonly MeshRecord[];
  readonly dangling: readonly MeshRecord[];
}

export interface Transaction<T> {
  readonly state: MeshState;
  readonly result: T;
}

/** `state/mesh.ts` (PR 3): a read-modify-write of `mesh.json` under `withStateLock`, bumping its generation. */
export interface MeshFile {
  read(): MeshState;
  transact<T>(change: (state: MeshState) => Transaction<T>): T;
}

/** What this host signs, as a draft: the signer fills in `mesh`, `by` and `n` (persisting `n` first, section 10.1). */
export type RecordDraft =
  | { readonly type: "ack"; readonly prev: readonly string[] }
  | {
      readonly type: "revoke";
      readonly prev: readonly string[];
      readonly signPubs: readonly string[];
      readonly reason: "revoke" | "compromised" | "leave";
    };

/** PR 2's `signRecord` with this host's signing key and PR 3's counter discipline. Called inside a transaction. */
export interface MeshSigner {
  readonly signPub: string;
  sign(draft: RecordDraft): MeshRecord;
}
