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
  type SecureSession,
  SessionKind,
} from "@doriface/crypto";
import { HELLO_REQUEST_LINE } from "@doriface/client";
import { OPEN_POLICY, type PlanPolicy, requireFeature, requireWithin } from "@doriface/policy";
import type { AuthorizeIndex } from "../mesh/authorize-index.ts";
import { REMOVED_READING } from "../mesh/roster-removal.ts";
import type { DeviceStore } from "../state/devices.ts";
import type { MeshStore } from "../state/mesh.ts";
import { type ClaimRefusal, JOIN_ON_DEVICE_OFFER, type PairingClaim, type PairingStore } from "../state/pairing.ts";
import { authorizationOf, handshakeRefusalLine, sessionPeer } from "./authorize.ts";
import type { SpeculativeHello } from "./speculative-hello.ts";

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
  readonly resumeKey?: ((key: string) => boolean) | undefined;
  /** Whether a removed member's key already holds its one roster session (#1493). */
  readonly removedRosterHeld?: ((key: string) => boolean) | undefined;
  readonly log: (line: string) => void;
  /** IP-literal LAN URLs of this host's `/v1/e2ee`, sent to clients in message 2. */
  readonly lanUrls: readonly string[];
  /** For tests: messages per direction between rekeys. */
  readonly rekeyInterval?: number | undefined;
  /** The plan this host runs under: it narrows pairing, paired devices and open sessions. */
  readonly policy: PlanPolicy;
  /** How many sessions this host serves now, for a plan's concurrent-session limit. */
  readonly live: { readonly count: () => number };
  /** Answers an early hello before key confirmation, within its own budget (#1271); absent, every hello waits. */
  readonly speculative?: Pick<SpeculativeHello, "answer"> | undefined;
}

const refuse = (closeCode: number, reason: string): Authorization => ({ accept: false, closeCode, reason });

/**
 * A typed code does not say which offer it opens, so a joiner reads the refusal of its typed-code join: 4401 means the
 * code opens a device pairing (it pairs as a device instead), and every other 4401 of that join goes out as 4411, so the
 * joiner keeps its own words for a used, expired or replaced invite (#1492). Older hosts send 4401 for all of them.
 */
const typedJoinVerdict = (verdict: Authorization): Authorization =>
  !verdict.accept && verdict.closeCode === CloseCode.UnknownDevice && verdict.reason !== JOIN_ON_DEVICE_OFFER
    ? { ...verdict, closeCode: CloseCode.MeshCodeRefused }
    : verdict;
const meshClaims = new WeakMap<SecureLink, PairingClaim>();

/** A mesh offer is spent by its first card, leaving a no-terminal refusal before the card unspent. */
export function spendMeshOffer(secure: SecureLink): boolean {
  const claim = meshClaims.get(secure);
  meshClaims.delete(secure);
  return claim?.complete() === true;
}

const HELLO_LINE = new TextEncoder().encode(HELLO_REQUEST_LINE);

/**
 * The one early payload this host may answer before the client confirms the keys: the exact framed hello every client
 * sends first, which names no core. Anything else waits for admission, as every byte after it does (#1271).
 */
const isHelloLine = (early: Uint8Array): boolean =>
  early.byteLength === HELLO_LINE.byteLength && early.every((byte, index) => byte === HELLO_LINE[index]);

/** A withdrawal the plan caused: the person reads the plan's own words, and the host's log records them. */
const planRefusal = (deps: E2eeDeps, code: number, what: string, message: string): Authorization => {
  deps.log(`plan: refused ${what}: ${message}`);
  return refuse(code, message);
};

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
): Promise<SecureSession | undefined> {
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
  /** The plan's gate on adding a device: the plan carries pairing, and the host has room for one more. */
  const pairingRoom = (remoteStatic: Uint8Array, joiningMesh: boolean): Authorization | undefined => {
    const feature = requireFeature(deps.policy, "pairing");
    if (!feature.allowed) return planRefusal(deps, CloseCode.UnknownDevice, "a pairing", feature.message);
    // A mesh handshake does not identify the member kind. The card's admission owns its devices or machines gate.
    if (joiningMesh) return undefined;
    let paired: number;
    try {
      const key = base64urlEncode(remoteStatic);
      const devices = deps.devices.list();
      if (devices.some((device) => device.clientStaticPub === key)) return undefined;
      paired = devices.length;
    } catch (error) {
      return refuse(1011, `cannot read the paired devices: ${String(error)}`);
    }
    const room = requireWithin(deps.policy, "devices", paired);
    return room.allowed ? undefined : planRefusal(deps, CloseCode.UnknownDevice, "a pairing", room.message);
  };
  const authorize = (hello: ClientHello): Authorization => {
    deviceName = hello.name ?? "";
    const mesh = hello.stream === "mesh";
    if (hello.kind === SessionKind.Session) {
      if (pairSession) return refuse(CloseCode.UnknownDevice, "a ?pair session carries only pairing");
      if (hello.stream !== "mesh" && hello.stream !== "push") {
        const room = requireWithin(deps.policy, "sessions", deps.live.count());
        if (!room.allowed) return planRefusal(deps, CloseCode.RateLimited, "a session", room.message);
      }
      const index = meshIndex(deps);
      if ("refused" in index) return refuse(1011, index.refused);
      const peer = sessionPeer(hello.stream, hello.remoteStatic, index.index, deps.devices);
      if (
        hello.stream === "roster" &&
        peer.kind === "refused" &&
        peer.reason === "unknown device" &&
        deps.resumeKey?.(base64urlEncode(hello.remoteStatic)) === true
      )
        return { accept: true };
      // A removed member's key may still read its own removal on the roster stream, and nothing else (design 10.3).
      if (
        hello.stream === "roster" &&
        peer.kind === "refused" &&
        index.index?.removed(base64urlEncode(hello.remoteStatic)) === true
      ) {
        if (deps.removedRosterHeld?.(base64urlEncode(hello.remoteStatic)) === true)
          return refuse(CloseCode.RateLimited, REMOVED_READING);
        return { accept: true };
      }
      return authorizationOf(peer);
    }
    if (hello.kind === SessionKind.PairLink) {
      const room = pairingRoom(hello.remoteStatic, mesh);
      return room ?? claimWith(() => deps.pairing.claimLink(Date.now(), mesh));
    }
    if (transport.kind !== "relay" || transport.openSlot === undefined) {
      return refuse(CloseCode.UnknownDevice, "typed-code pairing runs over the relay with ?pair");
    }
    const openSlot = transport.openSlot;
    const verdict =
      pairingRoom(hello.remoteStatic, mesh) ?? claimWith(() => deps.pairing.claimCode(openSlot, Date.now(), mesh));
    return mesh ? typedJoinVerdict(verdict) : verdict;
  };
  let secure: SecureSession;
  try {
    secure = await secureLink(link, {
      role: "responder",
      hostId: deps.identity.hostId,
      staticKey: rawStaticKey(deps.identity.noise),
      authorize: (hello) => {
        const verdict = authorize(hello);
        if (
          !verdict.accept &&
          (verdict.closeCode === CloseCode.UnknownDevice || verdict.closeCode === CloseCode.MeshCodeRefused)
        ) {
          deps.log(handshakeRefusalLine(hello, verdict.reason, verdict.closeCode));
        }
        return verdict;
      },
      lanUrls: deps.lanUrls,
      rekeyInterval: deps.rekeyInterval,
      answerEarly: (early, session) => {
        if (isHelloLine(early)) deps.speculative?.answer(early, session);
      },
    });
  } catch (error) {
    deps.log(`e2ee handshake refused: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (secure.kind !== SessionKind.Session && secure.stream === "mesh") {
    if (claim === undefined) {
      deps.log("e2ee: close code=4401 source=mesh-pairing: no mesh pairing claim");
      secure.close(CloseCode.UnknownDevice, "no mesh pairing claim");
      return undefined;
    }
    meshClaims.set(secure, claim);
    deps.log(`mesh join from "${deviceName}"`);
  } else if (secure.kind !== SessionKind.Session) {
    const index = meshIndex(deps);
    const admitted =
      claim === undefined || "refused" in index
        ? REFUSED_CLAIM
        : admitPairing(claim, deps.devices, secure.remoteStatic, deviceName, index.index, deps.policy);
    if (!admitted.ok) {
      deps.log(`e2ee: close code=${admitted.code} source=pairing-admission: ${admitted.reason}`);
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
  policy: PlanPolicy = OPEN_POLICY,
): Admission {
  if (!claim.complete())
    return { ok: false, code: CloseCode.UnknownDevice, reason: "the pairing offer was already used" };
  if (mesh?.claimsKey(base64urlEncode(clientStatic)) === true) {
    return { ok: false, code: CloseCode.UnknownDevice, reason: "this key belongs to a mesh member" };
  }
  try {
    const paired = devices.list();
    if (!paired.some((device) => device.clientStaticPub === base64urlEncode(clientStatic))) {
      const room = requireWithin(policy, "devices", paired.length);
      if (!room.allowed) return { ok: false, code: CloseCode.UnknownDevice, reason: room.message };
    }
    devices.add(clientStatic, name);
  } catch (error) {
    return { ok: false, code: 1011, reason: `cannot store the paired device: ${String(error)}` };
  }
  return { ok: true };
}

export const REVOKED = { code: CloseCode.UnknownDevice, reason: "device revoked" } as const;
