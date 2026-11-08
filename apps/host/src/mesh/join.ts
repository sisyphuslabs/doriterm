import type { HostIdentity } from "@doriface/crypto";
import {
  JOIN_DEADLINE_MS,
  JoinRefused,
  type MeshInvite,
  type MeshLines,
  runJoiner as runSharedJoiner,
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
}

/**
 * Runs the shared joiner (section 4.4) with this host's identity and a version 1 card, storing a checked welcome with
 * `MeshStore.adopt` (a mesh.json that appeared meanwhile wins and the join fails).
 */
export function runJoiner(lines: MeshLines, ctx: JoinerContext): Promise<string> {
  const { identity } = ctx;
  return runSharedJoiner(lines, {
    invite: ctx.invite,
    identity: { hostId: identity.hostId, sign: identity.sign, noisePub: identity.noise.publicKey },
    own: ctx.own,
    dialed: ctx.dialed,
    deadline: ctx.deadline,
    adopt: (records) => {
      if (!ctx.mesh.adopt(records, identity)) throw new JoinRefused("a mesh.json appeared on this host meanwhile");
      return true;
    },
    log: ctx.log,
  });
}
