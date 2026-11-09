// The `doriface-mesh` herdr document: what a mesh host publishes about its mesh (contract v1.5, design section 8.6).
// Any client can overwrite a herdr document, so readers treat it as advisory and never base a security decision on it.
// The shapes are type aliases, not interfaces, so a status is a JsonValue and goes into doc.set as it is.

/** The document a mesh host writes its status to. */
export const MESH_STATUS_DOC = "doriface-mesh";

/** The document a client device paired to the inviting host writes `{approve}` or `{deny}` to for a pending join. */
export const MESH_APPROVAL_DOC = "doriface-mesh-approve";

/**
 * The document a client device writes `{request: <nonce>}` to for a one-line Add a machine (#668): the host answers in
 * the same document with `{request, link, expiresAt}` (a single-use mesh offer that admits without asking) or
 * `{request, error}`; once a machine joins on it, `{request, joined: {name, hostId}}` replaces the link, and an offer
 * that expires unused leaves `{request, expired: true}`.
 */
export const MESH_OFFER_DOC = "doriface-mesh-offer";

export type MeshOfferDoc =
  | { readonly request: string; readonly client?: boolean }
  | { readonly request: string; readonly link: string; readonly expiresAt: number }
  | { readonly request: string; readonly error: string }
  | { readonly request: string; readonly expired: true }
  | { readonly request: string; readonly joined: { readonly name: string; readonly hostId: string } };

/** The offer document as written, or undefined for anything else (a reader treats it as advisory). */
export function parseMeshOfferDoc(value: unknown): MeshOfferDoc | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const request: unknown = Reflect.get(value, "request");
  if (typeof request !== "string" || request === "") return undefined;
  const link: unknown = Reflect.get(value, "link");
  const expiresAt: unknown = Reflect.get(value, "expiresAt");
  const error: unknown = Reflect.get(value, "error");
  if (typeof link === "string" && typeof expiresAt === "number") return { request, link, expiresAt };
  if (typeof error === "string") return { request, error };
  if (Reflect.get(value, "expired") === true) return { request, expired: true };
  const joined: unknown = Reflect.get(value, "joined");
  if (typeof joined === "object" && joined !== null) {
    const name: unknown = Reflect.get(joined, "name");
    const hostId: unknown = Reflect.get(joined, "hostId");
    if (typeof name === "string" && typeof hostId === "string") return { request, joined: { name, hostId } };
  }
  const client: unknown = Reflect.get(value, "client");
  if (client !== undefined && typeof client !== "boolean") return undefined;
  return { request, ...(client === undefined ? {} : { client }) };
}

/** The `v` of the status document; a reader refuses any other value. */
export const MESH_STATUS_VERSION = 1;

/**
 * A member's herdr line as this host's machine.list and the reconciler see it (design section 8.1); `self` is this
 * host, `absent` is not added (yet). `hc_missing` and `incompatible` are herdr's refusals to add or dial it.
 */
export type MeshLineState =
  | "self"
  | "connected"
  | "connecting"
  | "unreachable"
  | "hc_missing"
  | "incompatible"
  | "needs_login"
  | "absent";

/** The line states section 8.1 shows with herdr's reason. */
export const MESH_LINE_STATES_WITH_REASON: readonly MeshLineState[] = ["unreachable", "hc_missing", "incompatible"];

/** Why the reconciler cannot make one member's line match the view (design section 8.1). */
export type MeshLineStuck =
  | { readonly kind: "name_taken"; readonly name: string }
  | { readonly kind: "invalid_name"; readonly name: string; readonly message: string }
  | { readonly kind: "copied_core" }
  | { readonly kind: "line_idle" };

/**
 * A STUCK reason of the whole mesh on this host, or of one member's line (`member` is its hostId). `unknown` is what a
 * reader puts in place of a reason of a kind a newer host added (#1139); a host never writes it.
 */
export type MeshStuckReason =
  | { readonly kind: "unknown" }
  | (MeshLineStuck & { readonly member: string })
  | { readonly kind: "possibly_revoked" }
  /** This host was revoked (design section 6.4): by whom (hostIds), when (display only), and the grace period's end. */
  | { readonly kind: "read_only"; readonly until: string; readonly by: readonly string[]; readonly at: string | null }
  | { readonly kind: "removed_undecidable" }
  | { readonly kind: "log_full"; readonly records: number }
  | { readonly kind: "counter_behind"; readonly file: number; readonly mesh: number };

/**
 * After a 4404 from a member, this host dials it again only on presence or when its probe is due. `nextProbeAt` is an
 * absolute time, display only (design section 8.5), so the document stays the same while the countdown runs.
 */
export type MeshGate = { readonly kind: "offline"; readonly refusals: number; readonly nextProbeAt: string };

/** How the machine a mesh line replaced had been added: over ssh, with a `doriface-host connect` via, or another via. */
export type MeshReplacedKind = "ssh" | "connect" | "command";

/** The kind only: an ssh target or via command can carry a user, an address or a key path, so neither is copied. */
export type MeshReplacedMachine = {
  readonly name: string;
  /** `unknown` when a reader does not know the kind a newer host wrote (#1139); a host never writes it. */
  readonly kind: MeshReplacedKind | "unknown";
};

const REPLACED_KIND_TEXT: { readonly [K in MeshReplacedMachine["kind"]]: string } = {
  ssh: "added over ssh",
  connect: "doriface-host connect",
  command: "added with a --via command",
  unknown: "added another way",
};

/** `replaced machine "old" (added over ssh) with the mesh line`, as status and the reconciler's log say it. */
export const replacedMachineText = (replaced: MeshReplacedMachine): string =>
  `replaced machine "${replaced.name}" (${REPLACED_KIND_TEXT[replaced.kind]}) with the mesh line`;

/** Times are display only: ISO 8601 strings, except lastSessionAt in epoch milliseconds. Every key is a hostId. */
export type MeshMemberStatus = {
  readonly hostId: string;
  /** Last recorded admitted client session here; writes may be throttled. Absent for machines or no saved observation. */
  readonly lastSessionAt?: number;
  /** The mesh name in the view; null only from an older host's over-cap member (see `overCap`). */
  readonly name: string | null;
  /** The name this host's core gives the machine, which differs after a name fallback; null as for `name`. */
  readonly localName: string | null;
  /** The member's Noise key fingerprint, as `fingerprint` prints it; null as for `name`. */
  readonly fingerprint: string | null;
  /** The member that admitted it; null for the founder, whose governing admission is its own found record. */
  readonly admittedBy: string | null;
  /**
   * A mesh has no member cap (#806), so a host writes false. A host that predates that wrote true for an admitted key
   * past its 12th member (not dialed, cannot sign), and readers still parse it.
   */
  readonly overCap: boolean;
  /** `unknown` when a reader does not know the state a newer host wrote (#1139); a host never writes it. */
  readonly line: MeshLineState | "unknown";
  /** herdr's reason, for the states in MESH_LINE_STATES_WITH_REASON only. */
  readonly lineReason: string | null;
  /** The core id of the latest line hello from it; the card's `hcId` check uses it (design section 7.6). */
  readonly helloCoreId: string | null;
  /**
   * The machine added earlier for the same core (over ssh or with a via), which the reconciler replaced with the mesh
   * line (design section 8.1, migration).
   */
  readonly replacedMachine: MeshReplacedMachine | null;
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
  /** The name its machine had on this core (after a fallback it differs), which machine.list shows. */
  readonly localName: string;
  readonly fingerprint: string;
  readonly revokedBy: readonly string[];
  /** `unknown` when a reader does not know the reason a newer host wrote (#1139); a host never writes it. */
  readonly reason: "revoke" | "compromised" | "leave" | "unknown";
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
  /** What it joins as: approving a client grants control of every machine it can reach. */
  readonly kind: "machine" | "client";
  /** Absent only in documents from hosts predating committed joins. */
  readonly code?: string;
  readonly joinerConfirmed?: boolean;
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
  /** Members in member order (an older host lists its over-cap keys last). */
  readonly members: readonly MeshMemberStatus[];
  readonly revoked: readonly MeshRevokedStatus[];
  readonly removed: readonly MeshRemovedStatus[];
  readonly notices: readonly MeshNotice[];
  readonly pending: readonly MeshPendingJoin[];
  readonly budget: MeshBudget;
};
