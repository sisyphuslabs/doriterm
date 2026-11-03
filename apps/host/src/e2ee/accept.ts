import {
  type Authorization,
  base64urlEncode,
  type ByteLink,
  type ClientHello,
  CloseCode,
  type HostIdentity,
  PAIRING_CODE_ATTEMPTS,
  rawStaticKey,
  type SecureLink,
  secureLink,
  SessionKind,
} from "@doriface/crypto";
import type { AuthorizeIndex } from "../mesh/authorize-index.ts";
import type { DeviceStore } from "../state/devices.ts";
import type { MeshStore } from "../state/mesh.ts";
import type { ClaimRefusal, PairingClaim, PairingStore } from "../state/pairing.ts";
import { authorizationOf, sessionPeer } from "./authorize.ts";

/** Where a session arrived: the direct listener, or a relay session (`openSlot` is the slot a `?pair` session named). */
export type E2eeTransport =
  | { readonly kind: "lan" }
  | { readonly kind: "relay"; readonly openSlot?: string | undefined };

export interface E2eeDeps {
  readonly identity: HostIdentity;
  readonly devices: DeviceStore;
  readonly pairing: PairingStore;
  /** The mesh membership, when this host keeps one; its authorize index is consulted before the devices. */
  readonly mesh?: MeshStore | undefined;
  readonly log: (line: string) => void;
  /** IP-literal LAN URLs of this host's `/v1/e2ee`, sent to clients in message 2. */
  readonly lanUrls: readonly string[];
  /** For tests: messages per direction between rekeys. */
  readonly rekeyInterval?: number | undefined;
}

const refuse = (closeCode: number, reason: string): Authorization => ({ accept: false, closeCode, reason });

/**
 * Runs the responder handshake on a fresh session (contract v1.3 "Session kinds"). A session (0x01) admits only a
 * stored device, and never on a `?pair` relay session. A typed-code pairing (0x02) runs only on a relay session
 * opened with `?pair`, and reserves one of the offer's 10 attempts before anything is answered; a link pairing (0x03)
 * runs anywhere. Once the client confirmed the keys, a pairing burns the offer and stores the device. Every refusal
 * closes before the host has answered anything.
 */
export async function acceptE2ee(
  link: ByteLink,
  deps: E2eeDeps,
  transport: E2eeTransport,
): Promise<SecureLink | undefined> {
  let claim: PairingClaim | undefined;
  let deviceName = "";
  const pairSession = transport.kind === "relay" && transport.openSlot !== undefined;
  const claimWith = (claimed: () => PairingClaim | ClaimRefusal): Authorization => {
    let result: PairingClaim | ClaimRefusal;
    try {
      result = claimed();
    } catch (error) {
      return refuse(1011, `cannot record the pairing attempt: ${String(error)}`);
    }
    if ("refused" in result) return refuse(result.refused, result.reason);
    claim = result;
    if (result.retiredCode) logRetired(deps);
    return { accept: true, secret: result.secret };
  };
  const authorize = (hello: ClientHello): Authorization => {
    deviceName = hello.name ?? "";
    const mesh = hello.stream === "mesh";
    if (hello.kind === SessionKind.Session) {
      if (pairSession) return refuse(CloseCode.UnknownDevice, "a ?pair session carries only pairing");
      const index = meshIndex(deps);
      if ("refused" in index) return refuse(1011, index.refused);
      const peer = sessionPeer(hello.stream, hello.remoteStatic, index.index, deps.devices);
      if (peer.kind === "refused" && peer.reason !== "unknown device")
        deps.log(`mesh: refused a session: ${peer.reason}`);
      return authorizationOf(peer);
    }
    if (hello.kind === SessionKind.PairLink) return claimWith(() => deps.pairing.claimLink(Date.now(), mesh));
    if (transport.kind !== "relay" || transport.openSlot === undefined) {
      return refuse(CloseCode.UnknownDevice, "typed-code pairing runs over the relay with ?pair");
    }
    const openSlot = transport.openSlot;
    return claimWith(() => deps.pairing.claimCode(openSlot, Date.now(), mesh));
  };
  let secure: SecureLink;
  try {
    secure = await secureLink(link, {
      role: "responder",
      hostId: deps.identity.hostId,
      staticKey: rawStaticKey(deps.identity.noise),
      authorize,
      lanUrls: deps.lanUrls,
      rekeyInterval: deps.rekeyInterval,
    });
  } catch (error) {
    deps.log(`e2ee handshake refused: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (secure.kind !== SessionKind.Session && secure.stream === "mesh") {
    if (claim?.complete() !== true) {
      deps.log("mesh join refused: the offer was already used");
      secure.close(CloseCode.UnknownDevice, "the pairing offer was already used");
      return undefined;
    }
    deps.log(`mesh join from "${deviceName}"`);
  } else if (secure.kind !== SessionKind.Session) {
    const index = meshIndex(deps);
    const admitted =
      claim === undefined || "refused" in index
        ? REFUSED_CLAIM
        : admitPairing(claim, deps.devices, secure.remoteStatic, deviceName, index.index);
    if (!admitted.ok) {
      deps.log(`pairing refused: ${admitted.reason}`);
      secure.close(admitted.code, admitted.reason);
      return undefined;
    }
    deps.log(`paired device "${deviceName}"`);
  }
  return secure;
}

/** The mesh's authorize index (never an evaluation), or why it cannot be read. */
function meshIndex(deps: E2eeDeps): { readonly index: AuthorizeIndex | undefined } | { readonly refused: string } {
  try {
    return { index: deps.mesh?.authorizeIndex() };
  } catch (error) {
    deps.log(`cannot read the mesh state: ${String(error)}`);
    return { refused: "cannot read the mesh state" };
  }
}

function logRetired(deps: E2eeDeps): void {
  const expiresAt = deps.pairing.read()?.expiresAt;
  const until = expiresAt === undefined ? "it expires" : new Date(expiresAt).toISOString();
  deps.log(
    `pairing code retired after ${PAIRING_CODE_ATTEMPTS} failed attempts; the link still works until ${until}; run doriface-host pair for a new code`,
  );
}

export type Admission = { readonly ok: true } | { readonly ok: false; readonly code: number; readonly reason: string };

const REFUSED_CLAIM: Admission = { ok: false, code: CloseCode.UnknownDevice, reason: "no pairing claim" };

/**
 * Finishes a confirmed pairing: burns the offer first, then stores the device. A second handshake that confirmed with
 * an already used offer is refused, and a store failure leaves the offer burned rather than reusable.
 */
export function admitPairing(
  claim: PairingClaim,
  devices: DeviceStore,
  clientStatic: Uint8Array,
  name: string,
  mesh?: AuthorizeIndex | undefined,
): Admission {
  if (!claim.complete())
    return { ok: false, code: CloseCode.UnknownDevice, reason: "the pairing offer was already used" };
  if (mesh?.claimsKey(base64urlEncode(clientStatic)) === true) {
    return { ok: false, code: CloseCode.UnknownDevice, reason: "this key belongs to a mesh member" };
  }
  try {
    devices.add(clientStatic, name);
  } catch (error) {
    return { ok: false, code: 1011, reason: `cannot store the paired device: ${String(error)}` };
  }
  return { ok: true };
}

export const REVOKED = { code: CloseCode.UnknownDevice, reason: "device revoked" } as const;
