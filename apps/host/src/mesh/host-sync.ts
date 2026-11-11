import {
  base64urlDecode,
  base64urlEncode,
  type HostIdentity,
  rawStaticKey,
  type SecureLink,
  secureLink,
  SessionKind,
} from "@doriface/crypto";
import { hashOf, type Signed, type View, viewOf } from "@doriface/mesh";
import { connectRelayClient, type CreateSocket, type RelayProofs } from "@doriface/relay-client";
import { withPassRetry } from "../relay/pass-retry.ts";
import type { MeshStore } from "../state/mesh.ts";
import type { MemberEntry } from "./authorize-index.ts";
import { type Clock, monotonicClock, type Random } from "./clock.ts";
import { CLIENT_ADMISSION_FORMAT, formatReadiness } from "./format-readiness.ts";
import type { Gossip } from "./gossip.ts";
import type { HcTarget } from "./hc-machines.ts";
import { type HostRuntime, startHostRuntime } from "./host-runtime.ts";
import { machinesOf, meshViewOf } from "./mesh-view.ts";
import { NoUplinkError } from "./no-uplink.ts";
import type { MeshRuntime } from "./runtime.ts";
import { StoredMesh } from "./stored-mesh.ts";
import { liveFactsOf, NOT_RUNNING, type SyncFacts } from "./live-facts.ts";

/** The relay must open a member dial's socket within 10 s, as the Noise handshake after it must finish (L-E1). */
export const CONNECT_MS = 10_000;

export interface HostSyncOptions {
  readonly identity: HostIdentity;
  readonly mesh: MeshStore;
  /** The relay this host keeps its uplink to; members are dialed through it with this host's own Noise key. */
  readonly relay: {
    readonly url: string | undefined;
    readonly createSocket?: CreateSocket | undefined;
    /** This host's relay passes (contract v1.6): member dials carry a proof and skip the relay's address limit. */
    readonly proofs?: RelayProofs | undefined;
  };
  /** This host's own herdr core, and the pinned `via` (section 7.2): its program and state dir. */
  readonly hc: HcTarget;
  readonly stateDir: string;
  readonly program: string;
  /**
   * Closes, with 4401, every live session whose key the stored view no longer authorizes (`LiveSessions.closeRevoked`):
   * steps 2 to 4 of section 6.2 run on every member that merges a revoke (section 6.3), not only on the revoker.
   */
  readonly closeRevoked: () => void;
  /** Whether an authenticated session from this Noise key is open on this host (`LiveSessions.has`): presence. */
  readonly openFrom: (noisePub: string) => boolean;
  readonly log: (line: string) => void;
  readonly clock?: Clock;
  readonly random?: Random;
}

/**
 * Mesh sync in the running host (section 5): gossip starts once this host has a mesh.json (at start, after a join,
 * or on `mesh-changed`) and stops with the host. It serves every authenticated sync session from a member, keeps the
 * session a join ran on as the first one, dials members through the relay, and pushes what this host signed itself.
 */
export class HostSync {
  readonly #options: HostSyncOptions;
  readonly #seen = new Set<string>();
  #droppedAt: number | undefined;
  #running: HostRuntime | undefined;
  #stopped = false;
  readonly #stopPasses: () => void;

  constructor(options: HostSyncOptions) {
    this.#options = options;
    this.#stopPasses = options.relay.proofs?.onPass(() => this.#running?.runtime.policy.passRenewed()) ?? (() => {});
  }

  get gossip(): Gossip | undefined {
    return this.#running?.runtime.gossip;
  }

  /** The running mesh's live facts for `mesh status` (none before sync runs). */
  live(): SyncFacts {
    const runtime = this.#running?.runtime;
    return runtime === undefined
      ? NOT_RUNNING
      : liveFactsOf({ ...runtime, openFrom: this.#options.openFrom }, this.#clock());
  }

  /** The running mesh (sync, reconciler, lines) once this host has a mesh.json. */
  get runtime(): MeshRuntime | undefined {
    return this.#running?.runtime;
  }

  /**
   * Whether every machine in this host's mesh, itself aside, has answered that it reads the format a client admission
   * is written in (design of #942). The roster decides it, not whether gossip happens to run: a host that founds its
   * mesh to admit its first member has a roster of one, and no member is in it to be held back (#1415). An admission
   * passes the records it is written over, so a machine admitted on this host since gossip's last view is in the roster
   * it checks (#1436); the answers still come from gossip. The transaction that writes the admission hands in the view it
   * already holds, so the records are not evaluated again inside the lock (#2263).
   */
  formatReady(records?: readonly Signed[], view?: View): boolean {
    const gossip = this.gossip;
    const roster =
      records !== undefined
        ? meshViewOf(records, view ?? viewOf(records))
        : (gossip?.view ?? new StoredMesh(this.#options.mesh).view());
    const self = base64urlEncode(this.#options.identity.sign.publicKey);
    const members = machinesOf(roster)
      .map((member) => member.signPub)
      .filter((signPub) => signPub !== self);
    return formatReadiness(members, gossip?.formatAnswers() ?? [], CLIENT_ADMISSION_FORMAT).kind === "ready";
  }

  /** mesh.json may have changed outside sync (a join, an admit, a CLI write): start, or push what is new. */
  changed(): void {
    this.#sync(undefined);
  }

  /**
   * A mesh session HostMesh hands over (its sync hook): a member's sync session (sections 5.1 and 9.2), or the session
   * a join ran on once the join is over (section 4.4). On a join's session the inviter's side, the responder of the
   * pairing (the one that received the joiner's name), waits for the joiner's hello: its first line could otherwise
   * reach a joiner still reading the welcome, whose join lines close 4400 on it. It is attached before this host's
   * start sweep or pushes can dial, so they go over it instead of replacing it. The joiner acks its admission there.
   */
  adopt(secure: SecureLink): void {
    this.#sync(secure);
  }

  #sync(secure: SecureLink | undefined): void {
    if (this.#stopped) return;
    const file = this.#options.mesh.read();
    if (file === undefined) {
      if (secure !== undefined) {
        this.#options.log("mesh: close code=4401 source=host-sync-state: this host is in no mesh");
        secure.close(4401, "this host is in no mesh");
      }
      return;
    }
    const fresh = file.records.filter((record) => !this.#seen.has(hashOf(record)));
    for (const record of fresh) this.#seen.add(hashOf(record));
    const created = this.#running === undefined;
    const running = this.#running ?? this.#start(file.meshId);
    this.#running = running;
    const gossip = running.runtime.gossip;
    const joiner = secure !== undefined && this.#attach(gossip, secure);
    if (created) {
      running.start();
      this.#options.log(`mesh: sync started for mesh ${file.meshId}`);
    } else if (fresh.length > 0) gossip.stored(fresh);
    if (joiner) gossip.ackAdmission();
  }

  /** Attaches `secure` for its member; true for the joiner's side of a join's session. */
  #attach(gossip: Gossip, secure: SecureLink): boolean {
    const member = this.#memberOf(secure);
    if (member === undefined) {
      this.#options.log("mesh: close code=4401 source=host-sync-member: not a member of this mesh");
      secure.close(4401, "not a member of this mesh");
      return false;
    }
    if (secure.kind === SessionKind.Session) {
      gossip.attach(member.signPub, member.signPub, secure);
      return false;
    }
    const inviter = secure.peerName !== undefined;
    gossip.attach(member.signPub, inviter ? member.signPub : gossip.self, secure, false, inviter);
    return !inviter;
  }

  /** This host's relay uplink closed; it reconnects by itself. */
  uplinkDropped(): void {
    this.#droppedAt ??= this.#clock().now();
  }

  /** The uplink answered again: the misses seen while it was down go, and a long drop sweeps (section 5.1). */
  uplinkAnswered(): void {
    const since = this.#droppedAt;
    this.#droppedAt = undefined;
    if (since !== undefined) this.gossip?.uplinkReturned(this.#clock().now() - since);
  }

  /** Any authenticated session from a current member, an hc line included, is its presence (section 8.2). */
  presence(secure: SecureLink): void {
    const member = this.#memberOf(secure);
    if (member !== undefined) this.#running?.runtime.presence(member.signPub);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#stopPasses();
    await this.#running?.stop();
  }

  #start(meshId: string): HostRuntime {
    const { identity, mesh, log, hc, stateDir, program } = this.#options;
    if (this.#options.relay.url === undefined) log(`mesh: ${new NoUplinkError().message}`);
    const started = startHostRuntime({
      identity,
      mesh,
      meshId,
      hc,
      stateDir,
      program,
      clock: this.#clock(),
      random: this.#options.random ?? Math.random,
      log,
      dialSync: (member) => this.#dial(member, "mesh"),
      dialLine: (member) => this.#dial(member, "hc"),
      merged: (records) => {
        for (const record of records) this.#seen.add(hashOf(record));
        this.#options.closeRevoked();
      },
    });
    return started;
  }

  #clock(): Clock {
    return this.#options.clock ?? monotonicClock;
  }

  #memberOf(secure: SecureLink): MemberEntry | undefined {
    return this.#options.mesh.authorizeIndex()?.member(base64urlEncode(secure.remoteStatic));
  }

  async #dial(member: MemberEntry, stream: "mesh" | "hc"): Promise<SecureLink> {
    const { proofs, url } = this.#options.relay;
    if (url === undefined) return this.#dialOnce(member, stream);
    return withPassRetry(() => this.#dialOnce(member, stream), proofs, url);
  }

  /** Through this host's own relay only: a host that keeps no uplink dials no member rather than a default relay. */
  async #dialOnce(member: MemberEntry, stream: "mesh" | "hc"): Promise<SecureLink> {
    const { relay, identity } = this.#options;
    if (relay.url === undefined) throw new NoUplinkError();
    const link = await this.#opened(
      connectRelayClient({
        relayUrl: relay.url,
        hostId: member.hostId,
        ...(relay.createSocket === undefined ? {} : { createSocket: relay.createSocket }),
        ...(relay.proofs === undefined ? {} : { proofs: relay.proofs }),
      }),
    );
    return secureLink(link, {
      role: "initiator",
      hostId: member.hostId,
      staticKey: rawStaticKey(identity.noise),
      remoteStatic: base64urlDecode(member.noisePub),
      stream,
    });
  }

  /** A socket that has not opened by CONNECT_MS fails the dial; if it opens later, it is closed at once. */
  #opened<T extends { close(code?: number, reason?: string): void }>(pending: Promise<T>): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    let late = false;
    const cancel = this.#clock().after(CONNECT_MS, () => {
      late = true;
      reject(new Error(`the relay did not open the socket within ${CONNECT_MS / 1000} s`));
    });
    pending.then(
      (link) => {
        cancel();
        if (late) return link.close(1000, "opened too late");
        return resolve(link);
      },
      (error: unknown) => {
        cancel();
        reject(error);
      },
    );
    return promise;
  }
}
