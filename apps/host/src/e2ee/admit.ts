import { agentPairingCode, base64urlEncode, CloseCode, fingerprintOf, hostIdOf } from "@doriface/crypto";
import { OPEN_POLICY, type PlanPolicy, requireWithin } from "@doriface/policy";
import type { AuthorizeIndex } from "../mesh/authorize-index.ts";
import type { JoinDecision, PendingJoin, PendingJoins } from "../mesh/pending-joins.ts";
import type { DeviceStore } from "../state/devices.ts";
import type { PairingClaim } from "../state/pairing.ts";

export type Admission = { readonly ok: true } | { readonly ok: false; readonly code: number; readonly reason: string };

/** What the agent gate needs of the host's pending joins: it asks and expires, and never decides. */
export type AgentApprovals = Pick<PendingJoins, "ask" | "expire">;

/** Stores a device whose pairing completed, unless its key is a mesh member's or the plan has no room for it. */
function storeDevice(
  devices: DeviceStore,
  clientStatic: Uint8Array,
  name: string,
  mesh: AuthorizeIndex | undefined,
  policy: PlanPolicy,
): Admission {
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

const USED = { ok: false, code: CloseCode.UnknownDevice, reason: "the pairing offer was already used" } as const;

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
  if (!claim.complete()) return USED;
  return storeDevice(devices, clientStatic, name, mesh, policy);
}

/** What the agent's pairing session ends with when an owner did not approve it in time. */
export const AGENT_REFUSALS: Readonly<Record<Exclude<JoinDecision, "approved">, string>> = {
  denied: "the owner denied this agent",
  expired: "no owner approved this agent before the offer ended",
};

export interface AgentPairing {
  readonly claim: PairingClaim;
  readonly approvals: AgentApprovals | undefined;
  readonly handshakeHash: Uint8Array;
  readonly clientStatic: Uint8Array;
  readonly name: string;
  /** Settles when the agent's session closes before an owner answered, which ends its request. */
  readonly closed: Promise<void>;
}

/**
 * An agent offer's pairing (#2939): the offer is burned as soon as the handshake confirms, so no second party pairs on
 * it while this one waits; the request then waits for an owner's approval, until the offer's own expiry, and only an
 * approval stores the device. A denial, an expiry or the agent hanging up leaves no device.
 */
export async function approveAgent(
  pairing: AgentPairing,
  devices: DeviceStore,
  mesh: AuthorizeIndex | undefined,
  policy: PlanPolicy = OPEN_POLICY,
): Promise<Admission> {
  const { claim, approvals, clientStatic, name } = pairing;
  if (!claim.complete()) return USED;
  if (approvals === undefined) {
    return { ok: false, code: CloseCode.UnknownDevice, reason: "this host cannot ask an owner to approve an agent" };
  }
  const noisePub = base64urlEncode(clientStatic);
  const join: PendingJoin = {
    nonce: base64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    name,
    hostId: hostIdOf(clientStatic),
    fingerprint: fingerprintOf(clientStatic),
    noisePub,
    kind: "agent",
    expiresAt: claim.expiresAt,
    code: agentPairingCode(pairing.handshakeHash),
    // The agent has nothing left to confirm: an owner's approval settles the request at once.
    joinerConfirmed: true,
  };
  void pairing.closed.then(() => approvals.expire(join.nonce));
  const decision = await approvals.ask(join);
  if (decision !== "approved") return { ok: false, code: CloseCode.UnknownDevice, reason: AGENT_REFUSALS[decision] };
  return storeDevice(devices, clientStatic, name, mesh, policy);
}
