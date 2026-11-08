import { base64urlDecode, base64urlEncode, CloseCode, hostIdOf, PAIRING_TTL_MS } from "@doriface/crypto";
import { door } from "../door.ts";
import { hashOf, meshIdOf, parseRecord, signCard } from "../records/codec.ts";
import { MAX_RECORDS, type MemberKind, type Signed } from "../records/types.ts";
import { viewOf } from "../view/engine.ts";
import { cardBodyFor, type MemberIdentity, type OwnCard } from "./card.ts";
import { inviteKindOf, type MeshInvite } from "./invite.ts";
import type { MeshLine, MeshLines } from "./lines.ts";
import { byDeadline, JoinRefused } from "./refused.ts";

export interface JoinerContext {
  /** The target's proof of being a mesh invite ({@link meshInviteOf}): a device link or a hostId never gets this far. */
  readonly invite: MeshInvite;
  readonly identity: MemberIdentity;
  readonly own: OwnCard;
  /** What the card says this member is; absent writes a version 1 card, which is a machine. */
  readonly kind?: MemberKind | undefined;
  /** The member this joiner dialed: the hostId and Noise key it authenticated in the handshake. */
  readonly dialed: { readonly hostId: string; readonly noisePub: Uint8Array };
  /** Milliseconds since the epoch by which the offer and the whole welcome must have arrived. */
  readonly deadline: number;
  /** Stores a checked welcome as this member's mesh; false when another mesh appeared meanwhile and wins. */
  readonly adopt: (records: readonly Signed[]) => boolean | Promise<boolean>;
  readonly log: (line: string) => void;
}

/** An offer lives at most {@link PAIRING_TTL_MS}, and its pending join expires with it; a minute more is for the welcome. */
export const JOIN_DEADLINE_MS = PAIRING_TTL_MS + 60_000;

export type Offer = Extract<MeshLine, { t: "offer" }>;

/**
 * Reads `records` lines until `done`, then expects nothing more; a `refused` line ends the join with the inviter's
 * reason, and more records than a mesh may hold close the session with 4400. The bytes are bounded by the parser:
 * every record it admits is at most 2048 bytes of body and 86 characters of signature.
 */
async function welcome(lines: MeshLines, records: Signed[] = []): Promise<readonly Signed[]> {
  const line = await lines.next();
  if (line.t === "done") {
    lines.expect();
    return records;
  }
  if (line.t === "refused") throw new JoinRefused(`the inviting member refused: ${line.reason}`);
  if (line.t !== "records") throw new JoinRefused(`unexpected ${line.t} line in the welcome`);
  records.push(...line.records);
  if (records.length > MAX_RECORDS) return tooLarge(lines, "the welcome holds more records than a mesh may");
  return welcome(lines, records);
}

function tooLarge(lines: MeshLines, reason: string): never {
  lines.close(CloseCode.CryptoFailure, reason);
  throw new JoinRefused(reason);
}

/**
 * Section 4.4 step 5: every record passes the door in order; exactly one found, whose id is the offered mesh; the
 * dialed member is in the view with the hostId and Noise key this member authenticated; and this member is in the
 * view with its current Noise key. Whoever admitted it: the door already proved that the card its membership rests on
 * is signed by this member's own key, so it is its own card (the one just sent, or one an earlier attempt sent when
 * that attempt's welcome was lost: step 3's idempotent re-join, through any member, even after the admitter left).
 * Trusts nothing else in the welcome.
 */
export function checkWelcome(records: readonly Signed[], offer: Offer, ctx: JoinerContext): void {
  const stored: Signed[] = [];
  for (const record of records) {
    const verdict = door(record, stored);
    if (!verdict.ok) throw new JoinRefused(`the welcome's record ${hashOf(record)} was refused: ${verdict.reason}`);
    stored.push(record);
  }
  const founds = stored.filter((record) => parseRecord(record)?.type === "found");
  const [found] = founds;
  if (founds.length !== 1 || found === undefined) throw new JoinRefused("the welcome does not hold exactly one found");
  if (meshIdOf(found) !== offer.mesh) throw new JoinRefused("the welcome is for another mesh");
  const view = viewOf(stored);
  const inviter = offer.inviter;
  const inviterHost = hostIdOf(base64urlDecode(inviter));
  if (!view.members.has(inviter) || inviterHost !== ctx.dialed.hostId) {
    throw new JoinRefused("the dialed host is not the inviting member of this mesh");
  }
  if (view.noise.get(inviter) !== base64urlEncode(ctx.dialed.noisePub)) {
    throw new JoinRefused("the inviting member's key in the mesh is not the key this host dialed");
  }
  const self = base64urlEncode(ctx.identity.sign.publicKey);
  if (!view.members.has(self)) {
    throw new JoinRefused("the welcome does not admit this host with its own card");
  }
  if (view.noise.get(self) !== base64urlEncode(ctx.identity.noisePub)) {
    throw new JoinRefused("the welcome admits this host with another Noise key");
  }
}

/**
 * The joiner's side of section 4.4 on an open mesh session: answers the offer with this member's card for exactly
 * that mesh, inviter and nonce, checks the welcome, and hands it to `adopt` (a mesh that appeared meanwhile wins and
 * the join fails). A failure closes 4401 (4400 when the inviter sent a malformed or unexpected line) and stores
 * nothing; otherwise the join's parser lets go of the session, which stays open for whoever serves it next. Resolves
 * with the mesh id.
 */
export async function runJoiner(lines: MeshLines, ctx: JoinerContext): Promise<string> {
  try {
    return await byDeadline(join(lines, ctx), ctx.deadline, "the inviting member did not welcome this host in time");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.log(`mesh: join failed: ${reason}`);
    lines.refuse(CloseCode.UnknownDevice, reason);
    throw error instanceof JoinRefused ? error : new JoinRefused(reason, { cause: error });
  }
}

async function join(lines: MeshLines, ctx: JoinerContext): Promise<string> {
  const offer = await lines.next();
  if (offer.t === "refused") throw new JoinRefused(`the inviting member refused: ${offer.reason}`);
  if (offer.t !== "offer") throw new JoinRefused(`expected an offer, got ${offer.t}`);
  const placement = { mesh: offer.mesh, inviter: offer.inviter, nonce: offer.nonce, kind: ctx.kind };
  const body = cardBodyFor(ctx.identity, ctx.own, placement);
  lines.send({ t: "card", ...signCard(body, ctx.identity.sign.secretKey) });
  lines.expect("records", "done", "refused");
  const records = await welcome(lines);
  checkWelcome(records, offer, ctx);
  if (!(await ctx.adopt(records))) throw new JoinRefused("a mesh appeared on this member meanwhile");
  lines.detach();
  ctx.log(`mesh: joined mesh ${offer.mesh} via ${ctx.dialed.hostId} on a mesh ${inviteKindOf(ctx.invite)}`);
  return offer.mesh;
}
