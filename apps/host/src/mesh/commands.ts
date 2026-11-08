import { base64urlEncode, type HostIdentity } from "@doriface/crypto";
import { checkName, type RecordBody, type Signed, type Subject, type View } from "@doriface/mesh";
import { meshRevokeCommand } from "@doriface/protocol";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { withStateLock } from "../state/lock.ts";
import { MESH_FILE } from "../state/mesh-file.ts";
import type { MeshStore, MeshTx } from "../state/mesh.ts";
import type { LeaveReply, MemberRef, RenameReply, RevokeReply } from "./command-replies.ts";
import { machineKeysOf, meshViewOf } from "./mesh-view.ts";
import { findMember, memberRef, planRevoke } from "./revoke-plan.ts";
import type { MeshHooks } from "./host-hooks.ts";
import { checkFloor } from "./merge.ts";
import { hostIdOfKey } from "./status.ts";

/** How long a push of a record this host wrote collects confirmations (`mesh leave` waits for it, design 6.5). */
export const PUSH_WITHIN_MS = 30_000;

export interface MeshCommandDeps {
  readonly store: MeshStore;
  readonly stateDir: string;
  readonly identity: HostIdentity;
  /** `LiveSessions.closeRevoked()`: closes every session the stores no longer authorize, with 4401. */
  readonly closeRevoked: () => void;
  readonly hooks: MeshHooks;
  readonly log: (line: string) => void;
}

export interface RevokeRequest {
  readonly member: string;
  readonly compromised: boolean;
  readonly yes: boolean;
  /** Return the plan and write nothing: the CLI shows it before anything is written (design 6.1). */
  readonly preview?: boolean | undefined;
  /** The subjects' hostIds the operator saw in the preview; a plan that names others since is refused. */
  readonly expect?: readonly string[] | undefined;
}

export interface RenameRequest {
  readonly member: string;
  readonly name: string;
}

const INVALID_NAME =
  'is not a valid mesh name: 1 to 32 of a-z, 0-9, "-", "_" and ".", starting with a letter or digit, ' +
  "and not shaped like a terminal id such as t7";

/**
 * The running host's side of `mesh revoke`, `mesh rename` and `mesh leave` (design 6.1, 6.2, 6.5 and 7.5). Each
 * answers null when this host is in no mesh. A record is checked and signed in one mesh.json transaction, so the
 * view it was checked against is the view it is written on, and the device and known-host cleanup of section 6.7
 * happens in that same lock hold. While a peer's claim stands above this host's counter (section 10.1), each refuses
 * in that transaction instead of signing a counter the claimed records may already hold.
 */
export class MeshCommands {
  readonly deps: MeshCommandDeps;
  readonly #self: string;

  constructor(deps: MeshCommandDeps) {
    this.deps = deps;
    this.#self = base64urlEncode(deps.identity.sign.publicKey);
  }

  async revoke(request: RevokeRequest): Promise<RevokeReply | null> {
    const meshId = this.deps.store.read()?.meshId;
    if (meshId === undefined) return null;
    const { reply, record } = this.deps.store.transact((tx) => {
      const view = this.#member(tx);
      const machines = machineKeysOf(meshViewOf(tx.records, view));
      const plan = planRevoke(tx.records, view, this.#self, request.member, request.compromised, undefined, machines);
      const { target, subjects, reason, lines } = plan;
      const clients = this.#clientsOf(plan.keys);
      const needsYes = plan.needsYes || clients.length > 0;
      const preview = { target, subjects, clients, reason, lines, needsYes };
      if (request.preview === true || (needsYes && !request.yes)) {
        return { reply: { written: false, ...preview }, record: undefined };
      }
      const named = [...subjects, ...clients].map((subject) => subject.hostId);
      if (request.expect !== undefined && named.join(" ") !== request.expect.join(" ")) {
        throw new Error(
          `the mesh changed since the preview: this revoke would now name ${subjects.map((s) => s.name).join(", ")}; run it again`,
        );
      }
      const signed = this.#sign(tx, meshId, "revoke", { signPubs: plan.keys, reason });
      return { reply: { written: true, ...preview }, record: signed };
    });
    if (record !== undefined) this.#wrote(record);
    return reply;
  }

  async rename(request: RenameRequest): Promise<RenameReply | null> {
    const meshId = this.deps.store.read()?.meshId;
    if (meshId === undefined) return null;
    if (!checkName(request.name)) throw new Error(`"${request.name}" ${INVALID_NAME}`);
    const { reply, record } = this.deps.store.transact((tx) => {
      const view = this.#member(tx);
      const key = findMember(view, request.member);
      if (key === undefined || !view.members.has(key)) {
        throw new Error(`no member "${request.member}" in this host's view of the mesh`);
      }
      const renamed = { member: memberRef(view, key), name: request.name };
      if (view.name.get(key) === request.name) return { reply: { written: false, ...renamed }, record: undefined };
      const named = [...view.members, ...view.revoked].find(
        (other) => other !== key && hostIdOfKey(other) === request.name,
      );
      if (named !== undefined) {
        throw new Error(`"${request.name}" is the hostId of ${memberRef(view, named).name}; choose another`);
      }
      const holder = [...view.members].find((other) => other !== key && view.name.get(other) === request.name);
      if (holder !== undefined) throw new Error(`"${request.name}" is ${hostIdOfKey(holder)}; choose another`);
      const signed = this.#sign(tx, meshId, "name", { signPub: key, name: request.name });
      return { reply: { written: true, ...renamed }, record: signed };
    });
    if (record !== undefined) this.#wrote(record);
    return reply;
  }

  leavePreview(): { readonly clients: readonly MemberRef[] } {
    return { clients: this.#clientsOf([this.#self]) };
  }

  #clientsOf(admitters: readonly string[]): readonly MemberRef[] {
    return (this.deps.store.authorizeIndex()?.clients() ?? [])
      .filter((client) => client.admitter !== undefined && admitters.includes(client.admitter))
      .map(({ hostId, name }) => ({ hostId, name }))
      .toSorted((a, b) => a.hostId.localeCompare(b.hostId));
  }

  async leave(expect?: readonly string[]): Promise<LeaveReply | null> {
    const meshId = this.deps.store.read()?.meshId;
    if (meshId === undefined) return null;
    const { view, record } = this.deps.store.transact((tx) => {
      const clients = this.leavePreview().clients.map((client) => client.hostId);
      if (expect !== undefined && clients.join(" ") !== expect.join(" ")) {
        throw new Error("the clients leaving with this machine changed since the preview; run it again");
      }
      const current = tx.view();
      if (!current.members.has(this.#self)) return { view: current, record: undefined };
      const signed = this.#sign(tx, meshId, "revoke", { signPubs: [this.#self], reason: "leave" });
      return { view: current, record: signed };
    });
    const others = [...view.members].filter((key) => key !== this.#self);
    const confirmed = record === undefined || others.length === 0 ? [] : await this.#pushLeave(record);
    withStateLock(this.deps.stateDir, () => rmSync(join(this.deps.stateDir, MESH_FILE), { force: true }));
    this.deps.closeRevoked();
    const machinesKept = await this.deps.hooks.left().then(
      () => null,
      (error: unknown) => {
        this.deps.log(`mesh: removing this host's mesh machines after leaving failed: ${String(error)}`);
        return String(error);
      },
    );
    const name = view.name.get(this.#self) ?? this.deps.identity.hostId;
    return {
      signed: record !== undefined,
      members: others.map((key) => memberRef(view, key)),
      confirmed: others.filter((key) => confirmed.includes(key)).map((key) => memberRef(view, key)),
      revokeCommand:
        others.length > 0 && confirmed.length === 0
          ? (meshRevokeCommand(name) ?? `doriface-host mesh revoke ${this.deps.identity.hostId}`)
          : null,
      machinesKept,
    };
  }

  /** The view, once this host is a member of it: a revoked host signs nothing (section 6.4). */
  #member(tx: MeshTx): View {
    const view = tx.view();
    if (!view.members.has(this.#self)) {
      throw new Error("this host is not a member in its own view of the mesh (revoked), so it signs nothing");
    }
    return view;
  }

  #sign(tx: MeshTx, meshId: string, type: RecordBody["type"], subject: Subject): Signed {
    checkFloor(tx.records, this.#self, this.deps.hooks.floor());
    const at = new Date().toISOString();
    return tx.sign(this.deps.identity, (n, prev) => ({
      v: 2,
      mesh: meshId,
      type,
      by: this.#self,
      n,
      prev,
      subject,
      at,
    }));
  }

  /** Section 6.2 steps 2 and 3: close the sessions the record revoked, then push it. */
  #wrote(record: Signed): void {
    this.deps.closeRevoked();
    try {
      this.deps.hooks.push([record]);
    } catch (error) {
      this.deps.log(`mesh: pushing a record this host wrote failed: ${String(error)}`);
    }
  }

  /** Section 6.5: the self-revoke goes to every member it can reach within the window; the confirmed are counted. */
  async #pushLeave(record: Signed): Promise<readonly string[]> {
    try {
      this.deps.hooks.push([record]);
      return await this.deps.hooks.confirmations(PUSH_WITHIN_MS);
    } catch (error) {
      this.deps.log(`mesh: pushing this host's leave failed, so no member confirmed it: ${String(error)}`);
      return [];
    }
  }
}
