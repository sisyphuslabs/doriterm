import { base64urlDecode, base64urlEncode, CloseCode, fingerprintOf, type HostIdentity } from "@doriface/crypto";
import { type CardBody, checkName, type Signed, verifyCard } from "@doriface/mesh";
import { type PlanPolicy, requireWithin } from "@doriface/policy";
import type { MeshStore, OwnCard } from "../state/mesh.ts";
import type { AuthorizeIndex } from "./authorize-index.ts";
import { admissionRefusal } from "./format-readiness.ts";
import { type MeshLines, recordLines } from "./lines.ts";
import { checkFloor, type CounterFloor } from "./merge.ts";
import type { PendingJoin, PendingJoins } from "./pending-joins.ts";

export interface InviteDeps {
  readonly identity: HostIdentity;
  readonly mesh: MeshStore;
  readonly pending: PendingJoins;
  /** This host's own card fields, for the found it writes when it has no mesh yet. */
  readonly own: () => Promise<OwnCard>;
  /** The offer's expiry: a pending join expires with it. */
  readonly expiresAt: number;
  /** The highest claim a peer's `hello` holds on this host's counter: the admit is not signed below it (10.1). */
  readonly floor: () => CounterFloor | undefined;
  /** The plan this host runs under: its `machines` limit narrows what the protocol admits, and never widens it. */
  readonly policy: PlanPolicy;
  /** Whether every machine left in the mesh has shown it reads the format a client admission needs (design of #942). */
  readonly formatReady?: (() => boolean) | undefined;
  readonly log: (line: string) => void;
}

export class JoinRefused extends Error {
  override readonly name = "JoinRefused";
}

const nonce = (): string => base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

/** Settles like `promise`, or rejects with `JoinRefused(reason)` once the clock reaches `at`. */
export async function byDeadline<T>(promise: Promise<T>, at: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JoinRefused(reason)), Math.max(0, at - Date.now()));
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Founds the mesh if this host has none (a concurrent founding wins and is used), and returns its id. */
async function meshIdFor(deps: InviteDeps): Promise<string> {
  if (deps.mesh.read() === undefined) {
    const own = await deps.own();
    if (!checkName(own.name)) throw new JoinRefused(`this host's name "${own.name}" is not a valid mesh name`);
    deps.mesh.found(deps.identity, own);
  }
  const file = deps.mesh.read();
  if (file === undefined) throw new JoinRefused("cannot found the mesh");
  return file.meshId;
}

/** Section 4.4 step 3: the card must be for exactly this offer and bound to the Noise key that just proved itself. */
function checkCard(
  signed: Signed,
  offer: { mesh: string; inviter: string; nonce: string },
  peer: Uint8Array,
): CardBody {
  const card = verifyCard(signed);
  if (card === undefined) throw new JoinRefused("the card does not verify");
  if (card.mesh !== offer.mesh || card.inviter !== offer.inviter || card.nonce !== offer.nonce) {
    throw new JoinRefused("the card is not for this offer");
  }
  if (card.noisePub !== base64urlEncode(peer)) throw new JoinRefused("the card's Noise key is not the session's");
  return card;
}

function sendWelcome(lines: MeshLines, records: readonly Signed[], meshId: string): void {
  for (const line of recordLines(records)) lines.send(line);
  lines.send({ t: "done", mesh: meshId });
}

/**
 * Section 4.4 step 4, in one mesh.json transaction: admits the card unless its key became a member while the join
 * waited (then the welcome only, step 3), refuses what step 3 refuses as it stands now (a twin, a member with another
 * key) and a plan limit reached meanwhile, and returns the records to welcome.
 */
function admit(deps: InviteDeps, meshId: string, inviter: string, card: CardBody, signed: Signed): readonly Signed[] {
  const refusal = admissionRefusal(card.kind, deps.formatReady?.() === true);
  if (refusal !== undefined) throw new JoinRefused(refusal);
  return deps.mesh.transact((tx) => {
    const index = deps.mesh.authorizeIndex();
    if (isRejoin(index, card)) return tx.records;
    const joining = index?.memberCount ?? 0;
    const room = requireWithin(deps.policy, "machines", joining);
    if (!room.allowed) throw new JoinRefused(room.message);
    checkFloor(tx.records, inviter, deps.floor());
    tx.sign(deps.identity, (n, prev) => ({
      v: 2,
      mesh: meshId,
      type: "admit",
      by: inviter,
      n,
      prev,
      subject: { card: signed },
    }));
    deps.log(
      `mesh: admitted "${card.name}" ${card.hostId}, fingerprint ${fingerprintOf(base64urlDecode(card.noisePub))}`,
    );
    return tx.records;
  });
}

/**
 * Section 4.3: the inviting member's decision. A `refused` line from the joiner (the only line the parser hands on
 * now: any other closes the session), or the session's end, drops the pending join instead, and so does a session
 * that ended before an automatic approval.
 */
async function decision(lines: MeshLines, deps: InviteDeps, join: PendingJoin): Promise<void> {
  const left = lines.next().then(
    (line) => ({ left: `the joiner gave up: ${line.t === "refused" ? line.reason : line.t}` }),
    (error: unknown) => ({ left: `the session closed before the join was decided: ${messageOf(error)}` }),
  );
  const decided = await Promise.race([deps.pending.ask(join), left]);
  if (typeof decided === "object") {
    deps.pending.expire(join.nonce);
    throw new JoinRefused(decided.left);
  }
  const closed = lines.closed;
  if (closed !== undefined) throw new JoinRefused(`the session closed before the join was decided: ${closed.message}`);
  if (decided !== "approved") throw new JoinRefused(`the join was ${decided} on the inviting member`);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const ANOTHER_KEY = "this host is a member with another Noise key: rekey it, or revoke and re-admit it";
const KEY_HELD = "this Noise key is another mesh member's";

/**
 * Section 4.4 step 3 against the stored set: true for a member presenting the Noise key the mesh holds for it (the
 * welcome only). Refuses a member with another Noise key, and a new signing key presenting a Noise key that another
 * signing key's card names (#90): a twin of a current member would make the admit void (type_ok) and every later
 * record of this host with it, and a twin of a revoked or superseded key authorizes nobody.
 */
function isRejoin(index: AuthorizeIndex | undefined, card: CardBody): boolean {
  const holder = index?.member(card.noisePub);
  if (holder?.signPub === card.signPub) return true;
  if (holder !== undefined) throw new JoinRefused(KEY_HELD);
  if (index?.isMember(card.signPub) === true) throw new JoinRefused(ANOTHER_KEY);
  if (index?.namedByAnother(card.noisePub, card.signPub) === true) throw new JoinRefused(KEY_HELD);
  return false;
}

/**
 * The inviting member's side of a join (sections 4.3 and 4.4), on a session the mesh offer admitted: offer, card
 * (before the offer expires), the confirmation, the admit, then the welcome. A refusal sends `refused` and closes 4401;
 * otherwise the join's parser lets go of the session, which stays open for sync. Resolves with the admitted card.
 */
export async function serveJoin(lines: MeshLines, peerStatic: Uint8Array, deps: InviteDeps): Promise<CardBody> {
  try {
    const meshId = await meshIdFor(deps);
    const offer = { mesh: meshId, inviter: base64urlEncode(deps.identity.sign.publicKey), nonce: nonce() };
    lines.send({ t: "offer", ...offer });
    const reply = await byDeadline(lines.next(), deps.expiresAt, "the offer expired before the card arrived");
    lines.expect("refused");
    if (reply.t !== "card") throw new JoinRefused(`expected a card, got ${reply.t}`);
    const card = checkCard(reply, offer, peerStatic);
    const index = deps.mesh.authorizeIndex();
    if (isRejoin(index, card)) {
      sendWelcome(lines, deps.mesh.read()?.records ?? [], meshId);
      lines.detach();
      return card;
    }
    const room = requireWithin(deps.policy, "machines", index?.memberCount ?? 0);
    if (!room.allowed) throw new JoinRefused(room.message);
    const fingerprint = fingerprintOf(base64urlDecode(card.noisePub));
    const join = {
      nonce: offer.nonce,
      name: card.name,
      hostId: card.hostId,
      fingerprint,
      noisePub: card.noisePub,
      kind: card.kind === "client" ? ("client" as const) : ("machine" as const),
      expiresAt: deps.expiresAt,
    };
    await decision(lines, deps, join);
    sendWelcome(lines, admit(deps, meshId, offer.inviter, card, { body: reply.body, sig: reply.sig }), meshId);
    lines.detach();
    deps.pending.admitted(join);
    return card;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.log(`mesh: join refused: ${reason}`);
    lines.refuse(CloseCode.UnknownDevice, reason);
    throw error;
  }
}
