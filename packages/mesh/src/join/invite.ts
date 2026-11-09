import { JoinRefused } from "./refused.ts";

/** What a joiner was handed: a pairing link (its `m=1` flag says whether it is a mesh offer), a typed code, or a bare hostId. */
export type JoinTarget =
  | { readonly kind: "link"; readonly mesh: boolean }
  | { readonly kind: "code" }
  | { readonly kind: "host" };

export type InviteKind = "link" | "code";

const admitted: unique symbol = Symbol("doriface mesh invite");

/**
 * Proof that a join target is a mesh invite. Only {@link meshInviteOf} makes one and the joiner's context requires it,
 * so no caller of the shared joiner (the host CLI, the browser) can start a join off a device pairing link or a bare
 * hostId: the device/mesh split is decided here, once, in the host's own words, and the two cannot drift (#1386).
 */
export interface MeshInvite {
  readonly [admitted]: InviteKind;
}

export const HOST_TARGET_REFUSAL = "mesh join takes a mesh pairing link or code, not a hostId";
export const DEVICE_LINK_REFUSAL = "this link pairs a device: run doriface-host mesh pair on the member";

/**
 * A link says what it admits (`&m=1`), so a device link is refused before anything is dialed. A typed code cannot say
 * (the relay's slot answer carries no kind, #727), so it is admitted here and judged by the inviter: its `claimCode`
 * refuses a mesh-stream pairing on a device offer with 4401.
 */
export function meshInviteOf(target: JoinTarget): MeshInvite {
  if (target.kind === "host") throw new JoinRefused(HOST_TARGET_REFUSAL);
  if (target.kind === "link" && !target.mesh) throw new JoinRefused(DEVICE_LINK_REFUSAL);
  return { [admitted]: target.kind };
}

export const inviteKindOf = (invite: MeshInvite): InviteKind => invite[admitted];
