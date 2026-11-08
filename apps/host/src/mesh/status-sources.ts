import type { View } from "@doriface/mesh";
import type { MeshLineState, MeshLineStuck, MeshReplacedMachine } from "@doriface/protocol";

// What `mesh status` reads, one snapshot per call. Every key is a signing public key (base64url).
// Each part is owned by another module of the mesh (design section 11): the view by `packages/mesh`, the stored state
// by `state/mesh.ts`, pending joins by `mesh/join.ts`, sessions and the dial budget by `mesh/sync.ts` and
// `mesh/dial-policy.ts`, and the lines by `mesh/reconciler.ts`. These types are the narrow face status needs of them.

export type RevokeReason = "revoke" | "compromised" | "leave";

export interface RevocationFact {
  readonly name: string;
  readonly noisePub: string;
  readonly by: readonly string[];
  readonly reason: RevokeReason;
  readonly at: string | null;
}

/** Keys an undecidable backdated revoke of `revokedKey` removed (design section 3.7). */
export interface FailClosedFact {
  readonly removed: readonly string[];
  readonly revokedKey: string;
}

/**
 * The part of PR 2's `View` that status reads. `noise`, `name` and `admitter` cover every member; `admitter` maps
 * the founder to itself, since its governing admission is its own `found` record; status reads that as no admitter.
 */
export type ViewFacts = Pick<View, "members" | "revoked" | "noise" | "admitter" | "name">;

export interface LocalFacts {
  readonly meshId: string;
  readonly self: string;
  readonly generation: number;
  readonly records: number;
  /** `self.n` in mesh.json, and the highest counter of this host's key in the records or a standing claim. */
  readonly counter: { readonly file: number; readonly mesh: number };
  /** The name each member has on this core (mesh.json `local`, which state/mesh.ts keys by hostId). */
  readonly localNames: ReadonlyMap<string, string>;
  /** When this host first saw each admission (mesh.json `notices`). */
  readonly noticed: ReadonlyMap<string, Date>;
  readonly readOnlyUntil: Date | null;
  readonly possiblyRevoked: boolean;
}

export interface PeerFacts {
  readonly presence: boolean;
  readonly lastSync: Date | null;
  readonly owed: number;
  /** Set after a 4404: the 4404s in a row and when the next probe is due (the local timer's wall time). */
  readonly gate: { readonly refusals: number; readonly nextProbeAt: Date } | null;
  readonly unreachableSince: Date | null;
}

export interface LineFacts {
  readonly state: Exclude<MeshLineState, "self">;
  /** herdr's reason for `unreachable`, `hc_missing` and `incompatible`. */
  readonly reason: string | null;
  readonly stuck: MeshLineStuck | null;
  /** The core id of the latest line hello from the member, logged for the card's hcId check (design section 7.6). */
  readonly helloCoreId: string | null;
  /** The non-mesh machine (ssh or a via) this line replaced for the same core (design section 8.1). */
  readonly replaced: MeshReplacedMachine | null;
}

export interface PendingJoinFact {
  readonly nonce: string;
  readonly name: string;
  readonly hostId: string;
  readonly noisePub: string;
  readonly expiresAt: Date;
  /** What it joins as; the approval copy says what that grants. */
  readonly kind: "machine" | "client";
  readonly code?: string;
  readonly joinerConfirmed?: boolean;
}

export interface BudgetFacts {
  readonly waiting: number;
  readonly halvedUntil: Date | null;
}

export interface WitnessFacts {
  readonly pool: readonly string[];
  readonly ask: string | null;
}

export interface MeshSources {
  readonly view: ViewFacts;
  /**
   * The revoke record behind every key in `view.revoked`. Not part of View: PR 2 exports it beside View from the
   * record set (the revoke's signers, reason and time, and the revoked card's Noise key).
   */
  readonly revocations: ReadonlyMap<string, RevocationFact>;
  /** The fail-closed removals the view evaluation found (section 3.7); PR 2 exports these beside View too. */
  readonly failClosed: readonly FailClosedFact[];
  readonly local: LocalFacts;
  readonly pending: readonly PendingJoinFact[];
  readonly peers: ReadonlyMap<string, PeerFacts>;
  readonly lines: ReadonlyMap<string, LineFacts>;
  readonly budget: BudgetFacts;
  /** The revoke-time witness pool of a revoke of `subject` written by this host (design section 6.1). */
  readonly witnessPool: (subject: string) => WitnessFacts;
}
