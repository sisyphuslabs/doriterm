import { base64urlEncode, CloseCode, type HostIdentity } from "@doriface/crypto";
import { type CardBody, hashOf, type Signed, verifyCard } from "@doriface/mesh";
import { byDeadline, JoinRefused, type MeshLines, recordLines } from "@doriface/mesh/join";
import { type PlanPolicy, requireWithin } from "@doriface/policy";
import type { DeviceStore } from "../state/devices.ts";
import type { MeshStore } from "../state/mesh.ts";
import { clientDeviceCount, isRejoin } from "./admission.ts";
import { admissionRefusal } from "./format-readiness.ts";
import { checkFloor, type CounterFloor } from "./merge.ts";
import { RosterAdmits, type RosterAdmit, sweepRoster } from "./roster-admits.ts";
import { removedKey, untilRemoval } from "./roster-removal.ts";

export interface RosterDeps {
  readonly stateDir: string;
  readonly identity: HostIdentity;
  readonly mesh: MeshStore;
  readonly devices: DeviceStore;
  readonly policy: PlanPolicy;
  readonly formatReady: () => boolean;
  readonly floor: () => CounterFloor | undefined;
  readonly log: (line: string) => void;
  readonly changed?: (() => void) | undefined;
  readonly resume?: ((lines: MeshLines, key: string, nonce: string) => Promise<void>) | undefined;
}

function admitRoster(deps: RosterDeps, card: CardBody, signed: Signed): void {
  const marker = new RosterAdmits(deps.stateDir);
  let before: readonly RosterAdmit[] | undefined;
  let marked = false;
  deps.mesh.transact(
    (tx) => {
      const index = deps.mesh.authorizeIndex();
      if (index?.client(card.noisePub)?.signPub === card.signPub) return tx.records;
      const refusal = admissionRefusal("client", deps.formatReady());
      if (refusal !== undefined) throw new JoinRefused(refusal);
      if (isRejoin(index, card, tx.records)) return tx.records;
      const paired = deps.devices.list();
      if (!paired.some((device) => device.clientStaticPub === card.devicePub)) {
        throw new JoinRefused("this device is no longer paired");
      }
      const self = base64urlEncode(deps.identity.sign.publicKey);
      const room = requireWithin(deps.policy, "devices", clientDeviceCount(index, deps.devices, self) - 1);
      if (!room.allowed) throw new JoinRefused(room.message);
      checkFloor(tx.records, self, deps.floor());
      const admit = tx.sign(deps.identity, (n, prev) => ({
        v: 2,
        mesh: card.mesh,
        type: "admit",
        by: self,
        n,
        prev,
        subject: { card: signed },
      }));
      before = marker.read();
      marked = true;
      marker.writeHeld([
        ...(before ?? []),
        { admitId: hashOf(admit), signPub: card.signPub, devicePub: card.noisePub },
      ]);
      return tx.records;
    },
    () => {
      if (marked) marker.writeHeld(before);
    },
  );
  deps.changed?.();
}

/** One roster session, bound to its authenticated device key and fresh offer nonce. */
export async function serveRoster(lines: MeshLines, remoteStatic: Uint8Array, deps: RosterDeps): Promise<void> {
  // Gossip closes revoked sessions. Finish the reply before announcing, even when a transport failure interrupts it.
  let changed = false;
  const writing = {
    ...deps,
    changed: () => {
      changed = true;
    },
  };
  try {
    const file = deps.mesh.read();
    if (file === undefined) throw new JoinRefused("this host is in no mesh");
    const inviter = base64urlEncode(deps.identity.sign.publicKey);
    const key = base64urlEncode(remoteStatic);
    const index = deps.mesh.authorizeIndex();
    // A removed member's key reaches this stream only to read its own removal: it admits, leaves and resumes nothing.
    const removed = removedKey(index, key);
    const nonce = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    lines.send({ t: "offer", mesh: file.meshId, inviter, nonce });
    const reply = await byDeadline(lines.next(), Date.now() + 60_000, "the roster request expired");
    if (reply.t === "resume") {
      if (removed) throw new JoinRefused("a removed member cannot resume a join");
      if (deps.resume === undefined) throw new JoinRefused("Ask for a new invite");
      return await deps.resume(lines, key, reply.nonce);
    }
    lines.expect();
    if (reply.t !== "card" && reply.t !== "leave") throw new JoinRefused(`expected a client card, got ${reply.t}`);
    const signed = reply.t === "card" ? { body: reply.body, sig: reply.sig } : reply.card;
    const card = verifyCard(signed);
    if (card === undefined || card.kind !== "client") throw new JoinRefused("the roster requires a client card");
    if (card.noisePub !== key || card.devicePub !== key) throw new JoinRefused("the card is not the session's client");
    if (card.mesh !== file.meshId || card.inviter !== inviter || card.nonce !== nonce) {
      throw new JoinRefused("the card is not for this offer");
    }
    if (removed) {
      if (index?.removed(key, card.signPub) !== true) throw new JoinRefused("the card is not the removed member's");
      for (const line of recordLines(untilRemoval(file.records, card.signPub))) lines.send(line);
      lines.send({ t: "done", mesh: file.meshId });
      lines.detach();
      lines.close(1000, "this member was removed");
      return;
    }
    if (reply.t === "leave") {
      deps.mesh.transact((tx) => {
        const own = deps.mesh.authorizeIndex()?.client(key);
        if (own?.signPub !== card.signPub) throw new JoinRefused("only the session's current client may leave");
        checkFloor(tx.records, inviter, deps.floor());
        tx.sign(deps.identity, (n, prev) => ({
          v: 2,
          mesh: file.meshId,
          type: "revoke",
          by: inviter,
          n,
          prev,
          subject: { signPubs: [own.signPub], reason: "leave" },
        }));
      });
      writing.changed();
    } else {
      admitRoster(writing, card, signed);
      sweepRoster(writing);
      deps.mesh.recordClientSession(key);
    }
    for (const line of recordLines(deps.mesh.read()?.records ?? [])) lines.send(line);
    lines.send({ t: "done", mesh: file.meshId });
    lines.detach();
    lines.close(1000, "the roster is current");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.log(`mesh: close code=4401 source=roster: ${reason}`);
    lines.refuse(CloseCode.UnknownDevice, reason);
    throw error;
  } finally {
    if (changed) deps.changed?.();
  }
}
