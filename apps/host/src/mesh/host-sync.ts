import {
  base64urlDecode,
  base64urlEncode,
  DEFAULT_RELAY_URL,
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
    if (this.#stopped) return;
    const file = this.#options.mesh.read();
    if (file === undefined) return;
    const fresh = file.records.filter((record) => !this.#seen.has(hashOf(record)));
    for (const record of fresh) this.#seen.add(hashOf(record));
    if (this.#gossip === undefined) {
      this.#gossip = this.#start(file.meshId);
      return;
    }
    if (fresh.length > 0) this.#gossip.stored(fresh);
  }

  /**
   * A mesh session HostMesh hands over (its sync hook): a member's sync session (sections 5.1 and 9.2), or the session
   * a join ran on once the join is over (section 4.4). On a join's session the inviter's side, the responder of the
   * pairing (the one that received the joiner's name), waits for the joiner's hello: its first line could otherwise
   * reach a joiner still reading the welcome, whose join lines close 4400 on it.
   */
  adopt(secure: SecureLink): void {
    this.changed();
    const member = this.#memberOf(secure);
    const gossip = this.#gossip;
    if (member === undefined || gossip === undefined) return secure.close(4401, "not a member of this mesh");
    if (secure.kind === SessionKind.Session) return void gossip.attach(member.signPub, member.signPub, secure);
    const inviter = secure.peerName !== undefined;
    gossip.attach(member.signPub, inviter ? member.signPub : gossip.self, secure, false, inviter);
  }

  stop(): void {
    this.#stopped = true;
    this.#gossip?.stop();
  }

  #start(meshId: string): Gossip {
    const { identity, mesh, log } = this.#options;
    const clock = this.#options.clock ?? monotonicClock;
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
    gossip.start();
    gossip.uplinkReturned(Number.POSITIVE_INFINITY);
    log(`mesh: sync started for mesh ${meshId}`);
    return gossip;
  }

  #memberOf(secure: SecureLink): MemberEntry | undefined {
    return this.#options.mesh.authorizeIndex()?.member(base64urlEncode(secure.remoteStatic));
  }

  async #dial(member: MemberEntry): Promise<SecureLink> {
    const { relay, identity } = this.#options;
    const link = await connectRelayClient({
      relayUrl: relay.url ?? DEFAULT_RELAY_URL,
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
