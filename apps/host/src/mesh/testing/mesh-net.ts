import { SecureLinkError } from "@doriface/crypto";
import { DialPolicy, type DueReason } from "../dial-policy.ts";
import { Gossip, type GossipTimings } from "../gossip.ts";
import type { MeshChannel, MeshMessage } from "../sync-lines.ts";
import type { MeshMember, MeshRecord, MeshView } from "../upstream.ts";
import type { FakeClock } from "./fake-clock.ts";
import { FakeSigner, fakeRules, hashOfRecord, MemoryFile, MESH_ID } from "./fake-mesh.ts";

/** One end of an in-memory session. Lines cross as JSON text, asynchronously, like a relay hop. */
class MemoryEnd implements MeshChannel {
  peer: MemoryEnd | undefined;
  readonly sent: MeshMessage[] = [];
  #closed = false;
  readonly #messages = new Set<(message: MeshMessage) => void>();
  readonly #closes = new Set<(error: Error | undefined) => void>();
  readonly #held: string[] = [];

  get closed(): boolean {
    return this.#closed;
  }

  send(message: MeshMessage): void {
    if (this.#closed) return;
    this.sent.push(message);
    const text = JSON.stringify(message);
    queueMicrotask(() => this.peer?.deliver(text));
  }

  deliver(text: string): void {
    if (this.#closed) return;
    if (this.#messages.size === 0) {
      this.#held.push(text);
      return;
    }
    const message: MeshMessage = JSON.parse(text);
    for (const listener of this.#messages) listener(message);
  }

  /** Like a secure link, holds what arrives before the first listener and hands it over. */
  onMessage(listener: (message: MeshMessage) => void): () => void {
    this.#messages.add(listener);
    for (const text of this.#held.splice(0)) this.deliver(text);
    return () => this.#messages.delete(listener);
  }

  onClose(listener: (error: Error | undefined) => void): () => void {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    queueMicrotask(() => {
      for (const listener of this.#closes) listener(undefined);
      this.peer?.close();
    });
  }
}

export interface NetHost {
  readonly member: MeshMember;
  readonly file: MemoryFile;
  readonly signer: FakeSigner;
  readonly policy: DialPolicy;
  readonly gossip: Gossip;
  readonly dials: string[];
  readonly views: MeshView[];
}

/**
 * A relay between in-memory hosts that can partition them or take one offline: a dial that cannot reach its target
 * fails with 4404, and a partition closes the sessions that cross it, as a relay restart would.
 */
export class MeshNet {
  readonly hosts = new Map<string, NetHost>();
  readonly #clock: FakeClock;
  readonly #random: () => number;
  readonly #timings: GossipTimings | undefined;
  readonly #links: { a: string; b: string; end: MemoryEnd }[] = [];
  #groups: readonly (readonly string[])[] | undefined;
  readonly #offline = new Set<string>();
  readonly lines: { from: string; to: string; message: MeshMessage }[] = [];

  constructor(clock: FakeClock, random: () => number, timings?: GossipTimings) {
    this.#clock = clock;
    this.#random = random;
    this.#timings = timings;
  }

  add(member: MeshMember, records: readonly MeshRecord[]): NetHost {
    const file = new MemoryFile(records);
    const own = records.map((record) => fakeRules.headerOf(record)).filter((header) => header.by === member.signPub);
    const signer = new FakeSigner(member, Math.max(0, ...own.map((header) => header.n)));
    const due = { run: (_member: string, _reason: DueReason): void => undefined };
    const policy = new DialPolicy({ clock: this.#clock, random: this.#random, onDue: (m, r) => due.run(m, r) });
    const dials: string[] = [];
    const views: MeshView[] = [];
    const gossip = new Gossip({
      file,
      rules: fakeRules,
      signer,
      meshId: MESH_ID,
      self: member,
      clock: this.#clock,
      random: this.#random,
      policy,
      dial: (target) => {
        dials.push(target.name);
        return this.#connect(member.signPub, target.signPub);
      },
      onView: (view) => views.push(view),
      log: () => undefined,
      ...(this.#timings === undefined ? {} : { timings: this.#timings }),
    });
    due.run = (signPub, reason) => gossip.due(signPub, reason);
    const host = { member, file, signer, policy, gossip, dials, views };
    this.hosts.set(member.signPub, host);
    gossip.start();
    return host;
  }

  host(name: string): NetHost {
    const found = [...this.hosts.values()].find((host) => host.member.name === name);
    if (found === undefined) throw new Error(`no host ${name}`);
    return found;
  }

  reachable(a: string, b: string): boolean {
    if (this.#offline.has(a) || this.#offline.has(b)) return false;
    return this.#groups === undefined || this.#groups.some((group) => group.includes(a) && group.includes(b));
  }

  /** Splits the hosts (by name) into groups that cannot reach each other. */
  partition(...groups: readonly (readonly string[])[]): void {
    this.#groups = groups.map((group) => group.map((name) => this.host(name).member.signPub));
    this.#cut();
  }

  heal(): void {
    this.#groups = undefined;
  }

  offline(name: string): void {
    this.#offline.add(this.host(name).member.signPub);
    this.#cut();
  }

  online(name: string): void {
    this.#offline.delete(this.host(name).member.signPub);
  }

  converged(): boolean {
    const sets = [...this.hosts.values()].map((host) => setOf(host).join(","));
    return sets.every((set) => set === sets[0]);
  }

  #cut(): void {
    for (const link of this.#links) if (!this.reachable(link.a, link.b)) link.end.close();
  }

  async #connect(from: string, to: string): Promise<MeshChannel> {
    const target = this.hosts.get(to);
    if (target === undefined || !this.reachable(from, to)) {
      throw new SecureLinkError(4404, "host is not connected to the relay (4404)");
    }
    const near = new MemoryEnd();
    const far = new MemoryEnd();
    near.peer = far;
    far.peer = near;
    this.#tap(near, from, to);
    this.#tap(far, to, from);
    this.#links.push({ a: from, b: to, end: near });
    target.gossip.attach(from, from, far);
    return near;
  }

  #tap(end: MemoryEnd, from: string, to: string): void {
    const send = end.send.bind(end);
    end.send = (message) => {
      this.lines.push({ from, to, message });
      send(message);
    };
  }
}

export const setOf = (host: NetHost): readonly string[] => host.file.read().records.map(hashOfRecord).toSorted();
