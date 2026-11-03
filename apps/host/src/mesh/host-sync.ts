import {
  base64urlDecode,
  base64urlEncode,
  type HostIdentity,
  rawStaticKey,
  type SecureLink,
  secureLink,
  SessionKind,
} from "@doriface/crypto";
import { hashOf } from "@doriface/mesh";
import { connectRelayClient, type CreateSocket } from "@doriface/relay-client";
import type { MeshStore } from "../state/mesh.ts";
import type { MemberEntry } from "./authorize-index.ts";
import { type Clock, monotonicClock, type Random } from "./clock.ts";
import { DialPolicy } from "./dial-policy.ts";
import { Gossip } from "./gossip.ts";

export interface HostSyncOptions {
  readonly identity: HostIdentity;
  readonly mesh: MeshStore;
  /** The relay this host keeps its uplink to; members are dialed through it with this host's own Noise key. */
  readonly relay: { readonly url: string | undefined; readonly createSocket?: CreateSocket | undefined };
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
  #gossip: Gossip | undefined;
  #stopped = false;

  constructor(options: HostSyncOptions) {
    this.#options = options;
  }

  get gossip(): Gossip | undefined {
    return this.#gossip;
  }

  /** mesh.json may have changed outside sync (a join, an admit, a CLI write): start, or push what is new. */
  changed(): void {
    this.#sync(undefined);
  }

  /**
   * A mesh session HostMesh hands over (its sync hook): a member's sync session (sections 5.1 and 9.2), or the session
   * a join ran on once the join is over (section 4.4). It is attached before this host's start sweep or pushes can
   * dial, so they go over it instead of replacing it. On a join's session the inviter's side, the responder of the
   * pairing (the one that received the joiner's name), waits for the joiner's hello: its first line could otherwise
   * reach a joiner still reading the welcome, whose join lines close 4400 on it. The joiner acks its admission there.
   */
  adopt(secure: SecureLink): void {
    this.#sync(secure);
  }

  #sync(secure: SecureLink | undefined): void {
    if (this.#stopped) return;
    const file = this.#options.mesh.read();
    if (file === undefined) return secure?.close(4401, "this host is in no mesh");
    const fresh = file.records.filter((record) => !this.#seen.has(hashOf(record)));
    for (const record of fresh) this.#seen.add(hashOf(record));
    const created = this.#gossip === undefined;
    const gossip = this.#gossip ?? this.#create(file.meshId);
    this.#gossip = gossip;
    const joiner = secure !== undefined && this.#attach(gossip, secure);
    if (created) this.#begin(gossip, file.meshId);
    else if (fresh.length > 0) gossip.stored(fresh);
    if (joiner) gossip.ackAdmission();
  }

  /** Attaches `secure` for its member; true for the joiner's side of a join's session. */
  #attach(gossip: Gossip, secure: SecureLink): boolean {
    const member = this.#memberOf(secure);
    if (member === undefined) {
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
    if (since !== undefined) this.#gossip?.uplinkReturned(this.#clock().now() - since);
  }

  stop(): void {
    this.#stopped = true;
    this.#gossip?.stop();
  }

  #create(meshId: string): Gossip {
    const { identity, mesh, log } = this.#options;
    const clock = this.#clock();
    const random = this.#options.random ?? Math.random;
    const holder: { gossip?: Gossip } = {};
    const policy = new DialPolicy({ clock, random, onDue: (member, reason) => holder.gossip?.due(member, reason) });
    const gossip = new Gossip({
      store: mesh,
      identity,
      meshId,
      clock,
      random,
      policy,
      log,
      dial: (m) => this.#dial(m),
      onView: (_view, result) => {
        for (const record of result.added) this.#seen.add(hashOf(record));
      },
    });
    holder.gossip = gossip;
    return gossip;
  }

  /** Starts sync; a member that has signed nothing yet (a joiner whose kept session did not survive) acks first. */
  #begin(gossip: Gossip, meshId: string): void {
    gossip.start();
    gossip.ackAdmission();
    gossip.uplinkReturned(Number.POSITIVE_INFINITY);
    this.#options.log(`mesh: sync started for mesh ${meshId}`);
  }

  #clock(): Clock {
    return this.#options.clock ?? monotonicClock;
  }

  #memberOf(secure: SecureLink): MemberEntry | undefined {
    return this.#options.mesh.authorizeIndex()?.member(base64urlEncode(secure.remoteStatic));
  }

  /** Through this host's own relay only: a host that keeps no uplink dials no member rather than a default relay. */
  async #dial(member: MemberEntry): Promise<SecureLink> {
    const { relay, identity } = this.#options;
    if (relay.url === undefined) throw new Error("this host keeps no relay uplink, so it dials no member");
    const link = await connectRelayClient({
      relayUrl: relay.url,
      hostId: member.hostId,
      ...(relay.createSocket === undefined ? {} : { createSocket: relay.createSocket }),
    });
    return secureLink(link, {
      role: "initiator",
      hostId: member.hostId,
      staticKey: rawStaticKey(identity.noise),
      remoteStatic: base64urlDecode(member.noisePub),
      stream: "mesh",
    });
  }
}
