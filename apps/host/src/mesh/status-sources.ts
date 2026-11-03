import type { MeshLineState, MeshLineStuck } from "@doriface/protocol";

// What `mesh status` reads, one snapshot per call. Keys are signing public keys (base64url) unless named otherwise.
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

export interface ViewFacts {
  /** In member order. */
  readonly members: readonly string[];
  readonly overCap: readonly string[];
  readonly revoked: readonly string[];
  /** Noise public key (base64url) per member. */
  readonly noise: ReadonlyMap<string, string>;
  /** Who admitted each member; the founder has no entry. */
  readonly admitter: ReadonlyMap<string, string>;
  readonly name: ReadonlyMap<string, string>;
  readonly revocations: ReadonlyMap<string, RevocationFact>;
  readonly failClosed: readonly FailClosedFact[];
}

export interface LocalFacts {
  readonly meshId: string;
  readonly self: string;
  readonly generation: number;
  readonly records: number;
  /** `self.n` in mesh.json, and the highest counter of this host's key seen in the records or a peer's hello. */
  readonly counter: { readonly file: number; readonly mesh: number };
  /** The name each member has on this core, by hostId (mesh.json `local`). */
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
  /** Set after a 4404: the 4404s in a row and the time left to the next probe. */
  readonly gate: { readonly refusals: number; readonly nextProbeInMs: number } | null;
  readonly unreachableSince: Date | null;
}

export interface LineFacts {
  readonly state: Exclude<MeshLineState, "self">;
  readonly stuck: MeshLineStuck | null;
}

export interface PendingJoinFact {
  readonly nonce: string;
  readonly name: string;
  readonly hostId: string;
  readonly noisePub: string;
  readonly expiresAt: Date;
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
  readonly local: LocalFacts;
  readonly pending: readonly PendingJoinFact[];
  readonly peers: ReadonlyMap<string, PeerFacts>;
  readonly lines: ReadonlyMap<string, LineFacts>;
  readonly budget: BudgetFacts;
  /** The revoke-time witness pool of a revoke of `subject` written by this host (design section 6.1). */
  readonly witness: (subject: string) => WitnessFacts;
}
