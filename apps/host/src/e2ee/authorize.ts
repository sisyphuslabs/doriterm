import { type Authorization, base64urlEncode, type ClientHello, CloseCode, type Stream } from "@doriface/crypto";
import type { AuthorizeIndex, MemberEntry } from "../mesh/authorize-index.ts";
import type { DeviceStore } from "../state/devices.ts";

const refuse = (reason: string): Authorization => ({ accept: false, closeCode: CloseCode.UnknownDevice, reason });

/** Who a session's key is: a machine member that dials, a client member that connects, a paired device, or nobody. */
export type Peer =
  | { readonly kind: "member"; readonly member: MemberEntry }
  | { readonly kind: "client"; readonly member: MemberEntry }
  | { readonly kind: "device" }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * The mesh check (section 9.2, first column steps 1 and 2): a current member's Noise key is a machine; a client member's
 * session key is a client; a revoked member's key is refused; anything else is not the mesh's to decide. A MACHINE's
 * device key is still refused by the index itself, because a machine reaches its peers over its mesh line.
 */
export function meshPeer(index: AuthorizeIndex | undefined, key: string): Peer | undefined {
  const member = index?.member(key);
  if (member !== undefined) return { kind: "member", member };
  const client = index?.client(key);
  if (client !== undefined) return { kind: "client", member: client };
  const reason = index?.deviceRefusal(key);
  return reason === undefined ? undefined : { kind: "refused", reason };
}

/** The device check (step 3), against its own store. */
export const devicePeer = (devices: DeviceStore, key: Uint8Array): Peer =>
  devices.has(key) ? { kind: "device" } : { kind: "refused", reason: "unknown device" };

/**
 * A session (`0x01`) by its stream: the mesh stream admits only a machine member; the push stream only a paired device
 * (a machine member has no browser to notify, while a client's notices come through the paired entry it keeps); the hc
 * stream (absent or `"hc"`) admits a machine member, then a client member, then such a device.
 */
export function sessionPeer(
  stream: Stream | undefined,
  key: Uint8Array,
  index: AuthorizeIndex | undefined,
  devices: DeviceStore,
): Peer {
  const mesh = meshPeer(index, base64urlEncode(key));
  // Each stream decides explicitly, per kind: a client is a member of the roster but not a dialer, so the mesh stream
  // must never admit one, and the push stream keeps serving only a device entry (design of #942).
  if (stream === "mesh") {
    if (mesh?.kind === "member") return mesh;
    if (mesh?.kind === "refused") return mesh;
    return {
      kind: "refused",
      reason: mesh?.kind === "client" ? "a client does not dial the mesh" : "not a mesh member",
    };
  }
  if (stream === "push" || stream === "roster") {
    // A machine member's keys never open a push stream: a machine has no browser to notify. A client's notices are
    // served by the paired entry it keeps for exactly that purpose, which is what devicePeer answers for.
    if (mesh?.kind === "member") return { kind: "refused", reason: `a mesh member has no ${stream} stream` };
    if (mesh?.kind === "refused") return mesh;
    if (mesh?.kind === "client") return mesh;
    return devicePeer(devices, key);
  }
  if (mesh !== undefined) return mesh;
  return devicePeer(devices, key);
}

/**
 * The one line a host logs when its handshake refuses a session (4401, or 4411 for a refused typed-code mesh join):
 * the close code, the session's kind and stream, and why.
 */
export const handshakeRefusalLine = (
  hello: Pick<ClientHello, "kind" | "stream">,
  reason: string | undefined,
  closeCode: number = CloseCode.UnknownDevice,
): string =>
  `e2ee: close code=${closeCode} source=handshake kind=${hello.kind} stream=${hello.stream ?? "hc"}: ${reason}`;

export const authorizationOf = (peer: Peer): Authorization =>
  peer.kind === "refused" ? refuse(peer.reason) : { accept: true };
