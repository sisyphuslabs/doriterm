import { type ByteLink, SecureLinkError, type Unsubscribe } from "@doriface/crypto";
import { memoryLinkPair, type MemoryEnd } from "@doriface/crypto/testing";
import type { RecordBody, Signed, Subject } from "@doriface/mesh";
import { DialPolicy, type DueReason } from "../dial-policy.ts";
import { Gossip, type GossipTimings } from "../gossip.ts";
import type { MeshLine } from "../lines.ts";
import { type MeshView, meshViewOfIndex } from "../mesh-view.ts";
import { cardFor } from "../../testing/mesh-history.ts";
import type { MeshStore } from "../../state/mesh.ts";
import type { FakeClock } from "./fake-clock.ts";
import { hashes, meshIdOfRecords, type Peer, storeOf } from "./mesh-peers.ts";

export interface NetHost {
  readonly member: Peer;
  readonly store: MeshStore;
  readonly policy: DialPolicy;
  readonly gossip: Gossip;
  readonly dials: string[];
  readonly views: MeshView[];
  records(): readonly Signed[];
  /** Signs this host's next record through its store (the counter persisted first) and pushes it. */
  write(type: RecordBody["type"], subject?: Subject): Signed;
  /** Admits `joiner` with a card it signed, as a join on this host would. */
  admit(joiner: Peer): Signed;
  /** The names of the members of this host's stored view. */
  names(): readonly string[];
}

/** Holds what arrives before the first data listener and hands it over, as a secure link does. */
class HeldLink implements ByteLink {
  readonly #end: MemoryEnd;
  readonly #listeners = new Set<(bytes: Uint8Array) => void>();
  readonly #held: Uint8Array[] = [];

  constructor(end: MemoryEnd) {
    this.#end = end;
    end.onData((bytes) => {
      if (this.#listeners.size === 0) this.#held.push(bytes);
      for (const listener of this.#listeners) listener(bytes);
    });
  }

  send(bytes: Uint8Array): void {
    this.#end.send(bytes);
  }

  onData(listener: (bytes: Uint8Array) => void): Unsubscribe {
    this.#listeners.add(listener);
    for (const bytes of this.#held.splice(0)) listener(bytes);
    return () => this.#listeners.delete(listener);
  }

  onClose(listener: (error: Error | undefined) => void): Unsubscribe {
    return this.#end.onClose(listener);
  }

  close(code?: number, reason?: string): void {
    this.#end.close(code, reason);
  }
}

export interface NetLine {
  readonly from: string;
  readonly to: string;
  readonly line: MeshLine;
}

/**
 * A relay between in-memory hosts, each with its own mesh.json, that can partition them or take one offline: a dial
 * that cannot reach its target fails with 4404, and a partition closes the sessions that cross it, as a relay restart
 * would. Every line that crosses is recorded.
 */
export class MeshNet {
  readonly hosts = new Map<string, NetHost>();
  readonly lines: NetLine[] = [];
  readonly #clock: FakeClock;
  readonly #random: () => number;
  readonly #timings: GossipTimings | undefined;
  readonly #links: { readonly a: string; readonly b: string; readonly end: MemoryEnd }[] = [];
  readonly #offline = new Set<string>();
  readonly #broken = new Set<string>();
  #groups: readonly (readonly string[])[] | undefined;

  constructor(clock: FakeClock, random: () => number, timings?: GossipTimings) {
    this.#clock = clock;
    this.#random = random;
    this.#timings = timings;
  }

  add(
    member: Peer,
    records: readonly Signed[],
    onView?: (view: MeshView) => void,
    onDue?: (member: string, reason: DueReason) => void,
  ): NetHost {
    const store = storeOf(member, records);
    const due = { run: (_member: string, _reason: DueReason): void => undefined };
    const policy = new DialPolicy({ clock: this.#clock, random: this.#random, onDue: (m, r) => due.run(m, r) });
    const dials: string[] = [];
    const views: MeshView[] = [];
    const meshId = meshIdOfRecords(records);
    const gossip = new Gossip({
      store,
      identity: member.machine.identity,
      meshId,
      clock: this.#clock,
      random: this.#random,
      policy,
      dial: (target) => {
        dials.push(target.name);
        return this.#connect(member.signPub, target.signPub);
      },
      onView: (view) => {
        views.push(view);
        onView?.(view);
      },
      log: () => undefined,
      ...(this.#timings === undefined ? {} : { timings: this.#timings }),
    });
    due.run = (signPub, reason) => {
      gossip.due(signPub, reason);
      onDue?.(signPub, reason);
    };
    const host: NetHost = {
      member,
      store,
      policy,
      gossip,
      dials,
      views,
      records: () => store.read()?.records ?? [],
      write: (type, subject) => {
        const record = store.sign(member.machine.identity, (n, prev) => ({
          v: 2,
          mesh: meshId,
          type,
          by: member.signPub,
          n,
          prev,
          ...(subject === undefined ? {} : { subject }),
        }));
        gossip.stored([record]);
        return record;
      },
      admit: (joiner) => host.write("admit", { card: cardFor(joiner.machine, meshId, member.machine) }),
      names: () => {
        const index = store.read()?.index;
        return index === undefined
          ? []
          : meshViewOfIndex(index)
              .members.map((entry) => entry.name)
              .toSorted();
      },
    };
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

  /** Dials to the host fail like a timeout or a dropped connection: an error with no close code. */
  breakDials(name: string): void {
    this.#broken.add(this.host(name).member.signPub);
  }

  mendDials(name: string): void {
    this.#broken.delete(this.host(name).member.signPub);
  }

  converged(): boolean {
    const sets = [...this.hosts.values()].map((host) => setOf(host).join(","));
    return sets.every((set) => set === sets[0]);
  }

  #cut(): void {
    for (const link of this.#links) if (!this.reachable(link.a, link.b)) link.end.close(1001, "relay restart");
  }

  async #connect(from: string, to: string): Promise<ByteLink> {
    if (this.#broken.has(to)) throw new Error("the dial timed out");
    const target = this.hosts.get(to);
    if (target === undefined || !this.reachable(from, to)) {
      throw new SecureLinkError(4404, "host is not connected to the relay (4404)");
    }
    const [near, far] = memoryLinkPair();
    near.tap = this.#tap(from, to);
    far.tap = this.#tap(to, from);
    this.#links.push({ a: from, b: to, end: near });
    target.gossip.attach(from, from, new HeldLink(far));
    return new HeldLink(near);
  }

  #tap(from: string, to: string): (bytes: Uint8Array) => readonly Uint8Array[] {
    const decoder = new TextDecoder();
    let buffer = "";
    return (bytes) => {
      buffer += decoder.decode(bytes, { stream: true });
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const line: MeshLine = JSON.parse(buffer.slice(0, end));
        this.lines.push({ from, to, line });
        buffer = buffer.slice(end + 1);
      }
      return [bytes];
    };
  }
}

export const setOf = (host: NetHost): readonly string[] => hashes(host.records()).toSorted();
