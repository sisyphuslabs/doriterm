import {
  base64urlEncode,
  fingerprintOf,
  type HostIdentity,
  type PairingSecret,
  rawStaticKey,
  type SecureLink,
  secureLink,
} from "@doriface/crypto";
import { checkName } from "@doriface/mesh";
import {
  connectRelayClient,
  type CreateSocket,
  lookupPairSlot,
  pairSlotOf,
  type RelayProofs,
} from "@doriface/relay-client";
import { withPassRetry } from "../relay/pass-retry.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { confirmFingerprint, fingerprintGiven } from "../connect/dial.ts";
import type { ConnectTarget } from "../connect/target.ts";
import { loadDeviceKey } from "../state/known-hosts.ts";
import { MeshStore } from "../state/mesh.ts";
import { PairingStore } from "../state/pairing.ts";
import { type JoinTarget, type MeshInvite, meshInviteOf } from "@doriface/mesh/join";
import { JoinRefused } from "./invite.ts";
import { JOINER_EXPECTS, MeshLines } from "./lines.ts";
import { JOIN_DEADLINE_MS, runJoiner } from "./join.ts";

export interface JoinOptions {
  readonly stateDir: string;
  readonly identity: HostIdentity;
  readonly target: ConnectTarget;
  /** With a typed code: at least the first 4 groups of the inviting member's fingerprint. */
  readonly fingerprint: string | undefined;
  /** This host's mesh name (herdr's machine-name rule) and herdr core id, for its card. */
  readonly name: string;
  readonly hcId: string;
  /** Skips the link's interactive confirmation; never a typed code's fingerprint. */
  readonly yes: boolean;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly relayUrl: string | undefined;
  readonly defaultRelayUrl: string;
  readonly createSocket?: CreateSocket | undefined;
  /** This host's relay passes (contract v1.6): the pairing dial to the inviter carries a proof. */
  readonly proofs?: RelayProofs | undefined;
  readonly log: (line: string) => void;
}

export interface Joined {
  readonly meshId: string;
  readonly hostId: string;
  /** The session the join ran on; it stays open as a sync session. */
  readonly secure: SecureLink;
  readonly lines: MeshLines;
}

interface Inviter {
  readonly hostId: string;
  readonly hostKey: Uint8Array;
  readonly relayUrl: string;
  readonly pairing: PairingSecret;
  readonly pairSlot?: string;
}

const joinTargetOf = (target: ConnectTarget): JoinTarget =>
  target.kind === "link" ? { kind: "link", mesh: target.link.mesh === true } : { kind: target.kind };

/**
 * Section 4.2 step 2: every refusal that needs no network, checked before anything is dialed; the device/mesh split
 * itself is the shared joiner's (`meshInviteOf`), so the host and the browser refuse in the same words.
 */
async function refuseEarly(options: JoinOptions): Promise<MeshInvite> {
  const mesh = new MeshStore(options.stateDir, { log: options.log }).read();
  if (mesh !== undefined) throw new JoinRefused(`this host is in mesh ${mesh.meshId} already: run mesh leave first`);
  const offer = new PairingStore(options.stateDir).read();
  if (offer?.mesh === true && Date.now() < offer.expiresAt) {
    throw new JoinRefused("this host has an open mesh offer: a host cannot be invited and inviting at once");
  }
  if (!checkName(options.name)) throw new JoinRefused(`"${options.name}" is not a valid mesh name`);
  const { target } = options;
  const invite = meshInviteOf(joinTargetOf(target));
  if (target.kind !== "link") {
    fingerprintGiven(options.fingerprint);
    return invite;
  }
  if (options.yes) return invite;
  const question = `join the mesh of host ${target.link.hostId}, fingerprint ${fingerprintOf(target.link.noiseStaticPub)}?`;
  if (!(await options.confirm(question))) throw new JoinRefused("not joined");
  return invite;
}

async function inviterOf(options: JoinOptions): Promise<Inviter> {
  const { target, name } = options;
  if (target.kind === "link") {
    const { hostId, noiseStaticPub, linkSecret } = target.link;
    const relayUrl = options.relayUrl ?? target.link.relayUrl;
    return { hostId, hostKey: noiseStaticPub, relayUrl, pairing: { mode: "link", linkSecret, name } };
  }
  if (target.kind !== "code") throw new JoinRefused("mesh join takes a mesh pairing link or code");
  const relayUrl = options.relayUrl ?? options.defaultRelayUrl;
  const record = await lookupPairSlot({ relayUrl, code: target.code });
  if (record === undefined) throw new JoinRefused("no host is offering this code on the relay: it may have expired");
  confirmFingerprint(options.fingerprint, record.noiseStaticPub);
  const pairing = { mode: "code", code: target.code, name } as const;
  return {
    hostId: record.hostId,
    hostKey: record.noiseStaticPub,
    relayUrl,
    pairing,
    pairSlot: pairSlotOf(target.code),
  };
}

/**
 * Joins a mesh by pairing with one member (section 4.2): refusals first, then the pairing handshake as initiator with
 * this host's own Noise key and `stream: "mesh"`, then the join exchange. Stores the welcome only once it checked out.
 */
export async function joinMesh(options: JoinOptions): Promise<Joined> {
  const invite = await refuseEarly(options);
  const inviter = await inviterOf(options);
  const dialInviter = async () => {
    const link = await connectRelayClient({
      relayUrl: inviter.relayUrl,
      hostId: inviter.hostId,
      ...(options.createSocket === undefined ? {} : { createSocket: options.createSocket }),
      ...(options.proofs === undefined ? {} : { proofs: options.proofs }),
      ...(inviter.pairSlot === undefined ? {} : { pairSlot: inviter.pairSlot }),
    });
    return secureLink(link, {
      role: "initiator",
      hostId: inviter.hostId,
      staticKey: rawStaticKey(options.identity.noise),
      remoteStatic: inviter.hostKey,
      pairing: inviter.pairing,
      stream: "mesh",
    });
  };
  // A 4412 comes from the relay before the inviter sees anything, so the redial spends no pairing attempt.
  const secure = await withPassRetry(dialInviter, options.proofs, inviter.relayUrl);
  const deadline = Date.now() + JOIN_DEADLINE_MS;
  const lines = new MeshLines(secure, JOINER_EXPECTS);
  const hasDevice = existsSync(join(options.stateDir, "device-key.json"));
  const devicePub = hasDevice ? base64urlEncode(loadDeviceKey(options.stateDir).publicKey) : undefined;
  const own = { name: options.name, hcId: options.hcId, ...(devicePub === undefined ? {} : { devicePub }) };
  const mesh = new MeshStore(options.stateDir, { log: options.log });
  const dialed = { hostId: inviter.hostId, noisePub: inviter.hostKey };
  const meshId = await runJoiner(lines, {
    invite,
    identity: options.identity,
    mesh,
    own,
    dialed,
    deadline,
    log: options.log,
  });
  return { meshId, hostId: inviter.hostId, secure, lines };
}
