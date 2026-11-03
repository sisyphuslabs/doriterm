import type { Clock } from "./clock.ts";
import { type MeshChannel, type MeshMessage, recordLines } from "./sync-lines.ts";
import type { MergeResult } from "./merge.ts";
import type { MeshRecord, MeshRules } from "./upstream.ts";

/** Section 5.1: a sync session closes after 60 s without a line. */
export const LINGER_MS = 60_000;

export interface SyncHost {
  readonly meshId: string;
  readonly rules: MeshRules;
  records(): readonly MeshRecord[];
  merge(session: SyncSession, batch: readonly MeshRecord[]): MergeResult;
  /** The peer said which heads it holds (its `hello`). */
  heard(peer: string, heads: readonly string[]): void;
  ended(session: SyncSession): void;
}

export function countersOf(rules: MeshRules, records: readonly MeshRecord[]): Record<string, number> {
  const n: Record<string, number> = {};
  for (const record of records) {
    const { by, n: counter } = rules.headerOf(record);
    n[by] = Math.max(n[by] ?? 0, counter);
  }
  return n;
}

/**
 * One sync session (section 5.2): both sides say their heads, each sends what the other's heads do not cover, in
 * lines of at most 256 KiB ending with `done`, and asks once per session (`want`) for the past of a dangling record.
 * After any change it sends what the peer is still missing, so an ack goes back on the session that brought the batch.
 */
export class SyncSession {
  readonly peer: string;
  readonly dialer: string;
  /** This host opened it to sweep or probe: what it merges here is owed onwards (section 5.3). */
  readonly sweeping: boolean;
  readonly #channel: MeshChannel;
  readonly #host: SyncHost;
  readonly #clock: Clock;
  readonly #lingerMs: number;
  readonly #peerHeads = new Set<string>();
  readonly #sent = new Set<string>();
  readonly #wanted = new Set<string>();
  #incoming: MeshRecord[] = [];
  #idle: () => void = () => undefined;
  #closed = false;

  constructor(
    ends: { readonly peer: string; readonly dialer: string; readonly sweeping: boolean },
    channel: MeshChannel,
    host: SyncHost,
    clock: Clock,
    lingerMs = LINGER_MS,
  ) {
    this.peer = ends.peer;
    this.dialer = ends.dialer;
    this.sweeping = ends.sweeping;
    this.#channel = channel;
    this.#host = host;
    this.#clock = clock;
    this.#lingerMs = lingerMs;
    channel.onMessage((message) => this.#receive(message));
    channel.onClose(() => this.#ended());
  }

  get closed(): boolean {
    return this.#closed;
  }

  start(): void {
    this.#hello();
  }

  /** Sends every stored record the peer's known heads do not cover and that this session has not sent yet. */
  flush(): void {
    if (this.#closed) return;
    const { rules } = this.#host;
    const records = this.#host.records();
    const missing = rules
      .missingFor(records, [...this.#peerHeads])
      .filter((record) => !this.#sent.has(rules.headerOf(record).hash));
    if (missing.length === 0) return;
    for (const record of missing) this.#sent.add(rules.headerOf(record).hash);
    this.#sendAll(recordLines(missing));
  }

  close(code = 1000, reason = "sync done"): void {
    if (this.#closed) return;
    this.#channel.close(code, reason);
    this.#ended();
  }

  #hello(): void {
    const records = this.#host.records();
    const { rules, meshId } = this.#host;
    this.#send({ t: "hello", v: 2, mesh: meshId, heads: rules.headsOf(records), n: countersOf(rules, records) });
  }

  #receive(message: MeshMessage): void {
    if (this.#closed) return;
    this.#touch();
    switch (message.t) {
      case "hello":
        if (message.mesh !== this.#host.meshId) {
          this.close(4401, "a mesh stream from another mesh");
          return;
        }
        for (const head of message.heads) this.#peerHeads.add(head);
        this.#host.heard(this.peer, message.heads);
        this.flush();
        return;
      case "records":
        this.#incoming.push(...message.records);
        return;
      case "want":
        this.#answerWant(message.hashes);
        return;
      case "done":
        this.#merge();
        return;
      default: {
        const unknown: never = message;
        return unknown;
      }
    }
  }

  #merge(): void {
    const batch = this.#incoming;
    this.#incoming = [];
    if (batch.length === 0) return;
    for (const record of batch) this.#peerHeads.add(this.#host.rules.headerOf(record).hash);
    const result = this.#host.merge(this, batch);
    if (this.#closed) return;
    const want = result.wanted.filter((hash) => !this.#wanted.has(hash));
    for (const hash of want) this.#wanted.add(hash);
    if (want.length > 0) this.#send({ t: "want", hashes: want });
    if (result.added.length > 0) this.#hello();
  }

  #answerWant(hashes: readonly string[]): void {
    const wanted = new Set(hashes);
    const { rules } = this.#host;
    const found = this.#host.records().filter((record) => wanted.has(rules.headerOf(record).hash));
    for (const record of found) this.#sent.add(rules.headerOf(record).hash);
    this.#sendAll(recordLines(found));
  }

  #sendAll(messages: readonly MeshMessage[]): void {
    for (const message of messages) this.#send(message);
  }

  #send(message: MeshMessage): void {
    if (this.#closed) return;
    this.#touch();
    this.#channel.send(message);
  }

  #touch(): void {
    this.#idle();
    this.#idle = this.#clock.after(this.#lingerMs, () => this.close(1000, "idle"));
  }

  #ended(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#idle();
    this.#host.ended(this);
  }
}
