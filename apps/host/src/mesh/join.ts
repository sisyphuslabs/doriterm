import { base64urlEncode, type HostIdentity } from "@doriface/crypto";
import { signCard } from "@doriface/mesh";
import {
  cardBodyFor,
  checkWelcome,
  inviteKindOf,
  JOIN_DEADLINE_MS,
  JoinRefused,
  type MeshInvite,
  type MeshLines,
  runJoinCeremony,
} from "@doriface/mesh/join";
import type { MeshStore, OwnCard } from "../state/mesh.ts";

export { JOIN_DEADLINE_MS };

/** The host's side of a join: its file identity and its mesh.json, which the shared joiner never sees directly. */
export interface JoinerContext {
  /** The target's proof of being a mesh invite, from the refusals `join-dial.ts` runs before anything is dialed. */
  readonly invite: MeshInvite;
  readonly identity: HostIdentity;
  readonly mesh: MeshStore;
  readonly own: OwnCard;
  /** The member this host dialed: the hostId and Noise key it authenticated in the handshake. */
  readonly dialed: { readonly hostId: string; readonly noisePub: Uint8Array };
  /** Milliseconds since the epoch by which the offer and the whole welcome must have arrived. */
  readonly deadline: number;
  readonly log: (line: string) => void;
  readonly handshakeHash: Uint8Array;
  readonly yes: boolean;
  readonly confirm: ((code: string) => Promise<boolean>) | undefined;
}

/**
 * Runs the shared joiner (section 4.4) with this host's identity and a version 1 card, storing a checked welcome with
 * `MeshStore.adopt` (a mesh.json that appeared meanwhile wins and the join fails).
 */
export async function runJoiner(lines: MeshLines, ctx: JoinerContext): Promise<string> {
  const { identity } = ctx;
  const member = { hostId: identity.hostId, sign: identity.sign, noisePub: identity.noise.publicKey };
  const welcome = await runJoinCeremony(lines, {
    kind: "machine",
    handshakeHash: ctx.handshakeHash,
    dialed: { hostId: ctx.dialed.hostId, noisePub: base64urlEncode(ctx.dialed.noisePub) },
    expiresAt: ctx.deadline,
    yes: ctx.yes,
    confirm: ctx.confirm,
    card: async (offer) => signCard(cardBodyFor(member, ctx.own, offer), identity.sign.secretKey),
    saveAnchor: async () => undefined,
    clearAnchor: async () => undefined,
  }).catch((error: unknown) => {
    // The shared ceremony owns its close; distinguish its failure from checking/storing the welcome below.
    ctx.log(`mesh: join failed source=join-ceremony: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  });
  try {
    checkWelcome(welcome.records, welcome.offer, { identity: member, dialed: ctx.dialed });
    if (!ctx.mesh.adopt(welcome.records, identity))
      throw new JoinRefused("a mesh.json appeared on this host meanwhile");
    lines.detach();
    ctx.log(`mesh: joined mesh ${welcome.offer.mesh} via ${ctx.dialed.hostId} on a mesh ${inviteKindOf(ctx.invite)}`);
    return welcome.offer.mesh;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.log(`mesh: close code=4401 source=join-welcome: ${reason}`);
    lines.close(4401, reason);
    throw error;
  }
}
