import { base64urlDecode, base64urlEncode, CloseCode, fingerprintOf, type HostIdentity } from "@doriface/crypto";
import { type CardBody, checkName, type Signed, verifyCard } from "@doriface/mesh";
import { byDeadline, joinCode, joinCommit, JoinRefused, MeshProtocolError } from "@doriface/mesh/join";
import { type PlanPolicy, requireWithin } from "@doriface/policy";
import type { MeshStore, OwnCard } from "../state/mesh.ts";
import { clientDeviceCount, isRejoin } from "./admission.ts";
import { announceChange } from "./announce.ts";
import { admissionRefusal } from "./format-readiness.ts";
import { type MeshLines, recordLines } from "./lines.ts";
import { checkFloor, type CounterFloor } from "./merge.ts";
import type { PendingJoin, PendingJoins } from "./pending-joins.ts";
import type { DeviceStore } from "../state/devices.ts";
import { finishJoin, type JoinResumes } from "./join-resumes.ts";

export interface InviteDeps {
  readonly identity: HostIdentity;
  readonly mesh: MeshStore;
  readonly pending: PendingJoins;
  readonly resumes: JoinResumes;
  readonly devices: DeviceStore;
  readonly handshakeHash: Uint8Array;
  /** Spends the original pairing claim on its first card, rather than on the handshake. */
  readonly spend: () => boolean;
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
  /** Announces a committed client admission even if its original transport has disconnected. */
  readonly changed?: (() => void) | undefined;
  readonly log: (line: string) => void;
}

export { byDeadline, JoinRefused };

const nonce = (): string => base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

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
  if (card.kind === "client" && card.devicePub !== card.noisePub) {
    throw new JoinRefused("the client's device key is not the session's");
  }
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
  const records = deps.mesh.transact((tx) => {
    if (Date.now() >= deps.expiresAt) throw new JoinRefused("the offer expired before the admit was signed");
    const index = deps.mesh.authorizeIndex();
    if (isRejoin(index, card, tx.records)) return tx.records;
    const client = card.kind === "client";
    const joining = client
      ? clientDeviceCount(index, deps.devices, inviter) -
        (deps.devices.list().some((device) => device.clientStaticPub === card.devicePub) ? 1 : 0)
      : (index?.machineCount ?? 0);
    const room = requireWithin(deps.policy, client ? "devices" : "machines", joining);
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
  if (card.kind === "client") announceChange(deps);
  return records;
}

/**
 * The inviting member's side of a join (sections 4.3 and 4.4), on a session the mesh offer admitted: offer, card
 * (before the offer expires), the confirmation, the admit, then the welcome. A refusal sends `refused` and closes 4401;
 * otherwise the join's parser lets go of the session, which stays open for sync. Resolves with the admitted card.
 */
export async function serveJoin(lines: MeshLines, peerStatic: Uint8Array, deps: InviteDeps): Promise<CardBody> {
  try {
    const meshId = await meshIdFor(deps);
    const Ni = crypto.getRandomValues(new Uint8Array(32));
    const commit = deps.pending.isAuto() ? undefined : joinCommit(deps.handshakeHash, Ni);
    const offer = { mesh: meshId, inviter: base64urlEncode(deps.identity.sign.publicKey), nonce: nonce(), commit };
    lines.send({ t: "offer", ...offer });
    const reply = await byDeadline(lines.next(), deps.expiresAt, "the offer expired before the card arrived");
    lines.expect("refused");
    if (reply.t !== "card") throw new JoinRefused(`expected a card, got ${reply.t}`);
    if (!deps.spend()) throw new JoinRefused("this invite was used");
    if (lines.closed !== undefined) throw lines.closed;
    const card = checkCard(reply, offer, peerStatic);
    if (card.kind === "client" && commit === undefined) {
      throw new JoinRefused("this invite is for a machine; ask for an invite for a browser");
    }
    if (commit !== undefined && reply.sas === undefined) {
      throw new JoinRefused(
        "this machine's doriface-host is too old to join on an invite that asks: update it, or use Add a machine's one-line command",
      );
    }
    const index = deps.mesh.authorizeIndex();
    isRejoin(index, card, deps.mesh.read()?.records ?? []);
    if (commit === undefined) {
      sendWelcome(lines, admit(deps, meshId, offer.inviter, card, reply), meshId);
      deps.pending.admitted({ name: card.name, hostId: card.hostId, expiresAt: deps.expiresAt });
      lines.detach();
      return card;
    }
    const client = card.kind === "client";
    const count = client
      ? clientDeviceCount(index, deps.devices, offer.inviter) -
        (deps.devices.list().some((device) => device.clientStaticPub === card.devicePub) ? 1 : 0)
      : (index?.machineCount ?? 0);
    const room = requireWithin(deps.policy, client ? "devices" : "machines", count);
    if (!room.allowed) throw new JoinRefused(room.message);
    const refusal = admissionRefusal(card.kind, deps.formatReady?.() === true);
    if (refusal !== undefined) throw new JoinRefused(refusal);
    const fingerprint = fingerprintOf(base64urlDecode(card.noisePub));
    if (reply.sas === undefined) throw new JoinRefused("the card needs a join contribution");
    const join: PendingJoin = {
      nonce: offer.nonce,
      name: card.name,
      hostId: card.hostId,
      fingerprint,
      noisePub: card.noisePub,
      kind: card.kind === "client" ? ("client" as const) : ("machine" as const),
      expiresAt: deps.expiresAt,
      code: joinCode(deps.handshakeHash, Ni, base64urlDecode(reply.sas)),
      joinerConfirmed: false,
    };
    const welcome = deps.pending.ask(join).then((decision) => {
      if (decision !== "approved") throw new JoinRefused(`the join was ${decision} on the inviting member`);
      const records = admit(deps, meshId, offer.inviter, card, { body: reply.body, sig: reply.sig });
      deps.pending.admitted(join);
      return records;
    });
    const resumable = { join, card, Ni: base64urlEncode(Ni), welcome, records: () => deps.mesh.read()?.records ?? [] };
    deps.resumes.keep(resumable);
    await finishJoin(lines, resumable, deps.pending);
    return card;
  } catch (error) {
    const failure =
      lines.closed instanceof MeshProtocolError
        ? new JoinRefused(`the session closed before the join was decided: ${lines.closed.message}`)
        : error;
    const reason = failure instanceof Error ? failure.message : String(failure);
    deps.log(`mesh: join refused: ${reason}`);
    lines.refuse(CloseCode.UnknownDevice, reason);
    throw failure;
  }
}
