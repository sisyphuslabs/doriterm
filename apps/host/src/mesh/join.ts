import {
  base64urlDecode,
  base64urlEncode,
  CloseCode,
  type HostIdentity,
  hostIdOf,
  PAIRING_TTL_MS,
} from "@doriface/crypto";
import { door, hashOf, MAX_RECORDS, meshIdOf, parseRecord, type Signed, signCard, viewOf } from "@doriface/mesh";
import { cardBody, type MeshStore, type OwnCard } from "../state/mesh.ts";
import { byDeadline, JoinRefused } from "./invite.ts";
import type { MeshLine, MeshLines } from "./lines.ts";

export interface JoinerContext {
  readonly identity: HostIdentity;
  readonly mesh: MeshStore;
  readonly own: OwnCard;
  /** The member this host dialed: the hostId and Noise key it authenticated in the handshake. */
  readonly dialed: { readonly hostId: string; readonly noisePub: Uint8Array };
  /** Milliseconds since the epoch by which the offer and the whole welcome must have arrived. */
  readonly deadline: number;
  readonly log: (line: string) => void;
}

/** An offer lives at most {@link PAIRING_TTL_MS}, and its pending join expires with it; a minute more is for the welcome. */
export const JOIN_DEADLINE_MS = PAIRING_TTL_MS + 60_000;

type Offer = Extract<MeshLine, { t: "offer" }>;

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
 * dialed member is in the view with the hostId and Noise key this host authenticated; and this host is a member of the
 * view with its current Noise key. Whoever admitted it: the door already proved that the card its membership rests on
 * is signed by this host's own key, so it is this host's own card (the one just sent, or one an earlier attempt sent
 * when that attempt's welcome was lost: step 3's idempotent re-join, through any member, even after the admitter left).
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
  if (view.noise.get(self) !== base64urlEncode(ctx.identity.noise.publicKey)) {
    throw new JoinRefused("the welcome admits this host with another Noise key");
  }
}

/**
 * The joiner's side of section 4.4 on an open mesh session: answers the offer with this host's card for exactly that
 * mesh, inviter and nonce, checks the welcome, and stores it with `createPrivateJson` (a mesh.json that appeared
 * meanwhile wins and the join fails). A failure closes 4401 (4400 when the inviter sent a malformed or unexpected line)
 * and stores nothing; otherwise the join's parser lets go of the session, which stays open for sync. Resolves with the
 * mesh id.
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
  const body = cardBody(ctx.identity, ctx.own, offer.mesh, offer.inviter, offer.nonce);
  lines.send({ t: "card", ...signCard(body, ctx.identity.sign.secretKey) });
  lines.expect("records", "done", "refused");
  const records = await welcome(lines);
  checkWelcome(records, offer, ctx);
  if (!ctx.mesh.adopt(records, ctx.identity)) throw new JoinRefused("a mesh.json appeared on this host meanwhile");
  lines.detach();
  ctx.log(`mesh: joined mesh ${offer.mesh} via ${ctx.dialed.hostId}`);
  return offer.mesh;
}
