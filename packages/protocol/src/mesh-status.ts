// The `doriface-mesh` herdr document: what a mesh host publishes about its mesh (contract v1.5, design section 8.6).
// Any client can overwrite a herdr document, so readers treat it as advisory and never base a security decision on it.
// The shapes are type aliases, not interfaces, so a status is a JsonValue and goes into doc.set as it is.

/** The document a mesh host writes its status to. */
export const MESH_STATUS_DOC = "doriface-mesh";

/** The document a client device paired to the inviting host writes `{approve}` or `{deny}` to for a pending join. */
export const MESH_APPROVAL_DOC = "doriface-mesh-approve";

/** The `v` of the status document; a reader refuses any other value. */
export const MESH_STATUS_VERSION = 1;

/** A member's herdr line as this host's machine.list shows it; `self` is this host, `absent` is not added (yet). */
export type MeshLineState = "self" | "connected" | "connecting" | "unreachable" | "needs_login" | "absent";

/** Why the reconciler cannot make one member's line match the view (design section 8.1). */
export type MeshLineStuck =
  | { readonly kind: "name_taken"; readonly name: string }
  | { readonly kind: "invalid_name"; readonly name: string; readonly message: string }
  | { readonly kind: "copied_core" }
  | { readonly kind: "line_idle" };

/** A STUCK reason of the whole mesh on this host, or of one member's line (`member` is its hostId). */
export type MeshStuckReason =
  | (MeshLineStuck & { readonly member: string })
  | { readonly kind: "possibly_revoked" }
  | { readonly kind: "read_only"; readonly until: string }
  | { readonly kind: "removed_undecidable" }
  | { readonly kind: "log_full"; readonly records: number }
  | { readonly kind: "counter_behind"; readonly file: number; readonly mesh: number };

/** After a 4404 from a member, this host dials it again only on presence or when its probe is due. */
export type MeshGate = { readonly kind: "offline"; readonly refusals: number; readonly nextProbeS: number };

/** Times are ISO 8601 and display only. Every key is a hostId. */
export type MeshMemberStatus = {
  readonly hostId: string;
  /** The mesh name in the view. */
  readonly name: string;
  /** The name this host's core gives the machine, which differs after a name fallback. */
  readonly localName: string;
  /** The member's Noise key fingerprint, as `fingerprint` prints it. */
  readonly fingerprint: string;
  /** The member that admitted it; null for the founder. */
  readonly admittedBy: string | null;
  readonly overCap: boolean;
  readonly line: MeshLineState;
  /** An authenticated session from it is open now. */
  readonly presence: boolean;
  readonly lastSync: string | null;
  /** Records it has not confirmed yet. */
  readonly owed: number;
  readonly gate: MeshGate | null;
  /** Who could witness a revoke of this member written here (design section 6.1); empty makes it undecidable here. */
  readonly witnessPool: readonly string[];
  /** With an empty pool, a member from whose position the revoke would be decidable; null when there is none. */
  readonly witnessAsk: string | null;
  readonly unreachableSince: string | null;
  /**
   * It has been unreachable for more than 7 days: readers offer `meshRevokeCommand(name)`. The document carries no
   * command, since any client can rewrite it.
   */
  readonly revokeSuggested: boolean;
};

export type MeshRevokedStatus = {
  readonly hostId: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly revokedBy: readonly string[];
  readonly reason: "revoke" | "compromised" | "leave";
  readonly at: string | null;
};

/** Members an undecidable backdated revoke removed (design section 3.7): fail closed, recovered by re-founding. */
export type MeshRemovedStatus = {
  readonly members: readonly { readonly hostId: string; readonly name: string }[];
  readonly revokedKey: { readonly hostId: string; readonly name: string };
};

/** Shown for 7 days on every member after an admission. */
export type MeshNotice = {
  readonly hostId: string;
  readonly name: string;
  readonly admittedBy: string;
  readonly fingerprint: string;
  readonly seenAt: string;
  readonly until: string;
};

/** A joiner waiting for this host's approval (design section 4.3). */
export type MeshPendingJoin = {
  readonly nonce: string;
  readonly name: string;
  readonly hostId: string;
  readonly fingerprint: string;
  readonly expiresAt: string;
};

export type MeshBudget = {
  /** Dials waiting for the dial budget now. */
  readonly waiting: number;
  /** A 4429 halved the budget until then; null when it is whole. */
  readonly halvedUntil: string | null;
};

export type MeshStatus = {
  readonly v: typeof MESH_STATUS_VERSION;
  readonly meshId: string;
  /** This host. */
  readonly self: string;
  /** mesh.json's generation the status was computed from. */
  readonly generation: number;
  readonly sync: "ok" | "stuck";
  readonly stuck: readonly MeshStuckReason[];
  /** Members in member order, over-cap ones last. */
  readonly members: readonly MeshMemberStatus[];
  readonly revoked: readonly MeshRevokedStatus[];
  readonly removed: readonly MeshRemovedStatus[];
  readonly notices: readonly MeshNotice[];
  readonly pending: readonly MeshPendingJoin[];
  readonly budget: MeshBudget;
};
