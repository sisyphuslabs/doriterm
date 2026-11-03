import { type Authorization, base64urlEncode, CloseCode, type Stream } from "@doriface/crypto";
import type { AuthorizeIndex, MemberEntry } from "../mesh/authorize-index.ts";
import type { DeviceStore } from "../state/devices.ts";

const refuse = (reason: string): Authorization => ({ accept: false, closeCode: CloseCode.UnknownDevice, reason });

/** Who a session's key is: a current mesh member, a paired device, or nobody the host admits. */
export type Peer =
  | { readonly kind: "member"; readonly member: MemberEntry }
  | { readonly kind: "device" }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * The mesh check (section 9.2, first column steps 1 and 2): a current member's Noise key is a member; a revoked or
 * over-cap member's key, or a member's device key, is refused; anything else is not the mesh's to decide.
 */
export function meshPeer(index: AuthorizeIndex | undefined, key: string): Peer | undefined {
  const member = index?.member(key);
  if (member !== undefined) return { kind: "member", member };
  const reason = index?.deviceRefusal(key);
  return reason === undefined ? undefined : { kind: "refused", reason };
}

/** The device check (step 3), against its own store. */
export const devicePeer = (devices: DeviceStore, key: Uint8Array): Peer =>
  devices.has(key) ? { kind: "device" } : { kind: "refused", reason: "unknown device" };

/**
 * A session (`0x01`) by its stream: the mesh stream admits only a current member; the hc stream (absent or `"hc"`)
 * admits a member, else a paired device that is no member's key.
 */
export function sessionPeer(
  stream: Stream | undefined,
  key: Uint8Array,
  index: AuthorizeIndex | undefined,
  devices: DeviceStore,
): Peer {
  const mesh = meshPeer(index, base64urlEncode(key));
  if (stream === "mesh")
    return mesh?.kind === "member" ? mesh : (mesh ?? { kind: "refused", reason: "not a mesh member" });
  return mesh ?? devicePeer(devices, key);
}

export const authorizationOf = (peer: Peer): Authorization =>
  peer.kind === "refused" ? refuse(peer.reason) : { accept: true };
