import { closeCodeOf } from "@doriface/crypto";
import { type Clock, type Random, uniform } from "./clock.ts";
import { type DialPolicy, type DialPurpose, type DueReason } from "./dial-policy.ts";
import type { MeshChannel } from "./sync-lines.ts";
import { appendOwn, type MergeDeps, type MergeResult, mergeBatch } from "./merge.ts";
import { type SyncHost, SyncSession } from "./sync.ts";
import type { MeshMember, MeshRecord, MeshRules, MeshView, RecordDraft } from "./upstream.ts";

/** Section 5.1 and 5.3's timings, production values. */
export const GOSSIP_TIMINGS = {
  sweepAfterDownMs: 120_000,
  safetyNetMs: 600_000,
  safetyNetJitterMs: 120_000,
  revokedLastMs: 10_000,
  lingerMs: 60_000,
} as const;

export type GossipTimings = { readonly [K in keyof typeof GOSSIP_TIMINGS]: number };

export interface GossipOptions extends MergeDeps {
  readonly meshId: string;
  readonly self: MeshMember;
  readonly clock: Clock;
  readonly random: Random;
  readonly policy: DialPolicy;
  /** Opens a sync session (`stream:"mesh"`) to a member; rejects with the close code that refused it. */
  readonly dial: (member: MeshMember) => Promise<MeshChannel>;
  readonly onView?: (view: MeshView, result: MergeResult) => void;
  readonly log: (line: string) => void;
  readonly timings?: GossipTimings;
}

/**
 * Keeps this host's record set converged with every member's (section 5): on-demand sync sessions to push what a
 * member is owed, a return sweep after this host's own outage, a safety net every 10 minutes, and presence-driven
 * delivery to members that were offline. No member is redialed just to keep a session.
 */
export class Gossip implements SyncHost {
  readonly meshId: string;
  readonly rules: MeshRules;
  readonly #options: GossipOptions;
  readonly #timings: GossipTimings;
  readonly #sessions = new Map<string, SyncSession>();
  readonly #confirmed = new Map<string, readonly string[]>();
  readonly #lastSync = new Map<string, number>();
  readonly #known = new Map<string, MeshMember>();
  readonly #holdBack = new Map<string, () => void>();
  readonly #ackWaiters = new Set<() => void>();
  #view: MeshView;
  #stopNet: () => void = () => undefined;

  constructor(options: GossipOptions) {
    this.#options = options;
    this.meshId = options.meshId;
    this.rules = options.rules;
    this.#timings = options.timings ?? GOSSIP_TIMINGS;
    this.#view = options.rules.viewOf(options.file.read().records);
    this.#remember(this.#view);
  }

  get view(): MeshView {
    return this.#view;
  }

  start(): void {
    this.#armSafetyNet();
  }

  stop(): void {
    this.#stopNet();
    for (const cancel of this.#holdBack.values()) cancel();
    for (const session of this.#sessions.values()) session.close(1000, "host stopping");
  }

  records(): readonly MeshRecord[] {
    return this.#options.file.read().records;
  }

  /** An authenticated sync session, inbound or outbound; one per peer, as section 5.1 picks it. */
  attach(peer: string, dialer: string, channel: MeshChannel, sweeping = false): SyncSession {
    const ends = { peer, dialer, sweeping };
    const session = new SyncSession(ends, channel, this, this.#options.clock, this.#timings.lingerMs);
    const existing = this.#sessions.get(peer);
    if (existing !== undefined && !existing.closed) {
      const keepOld = existing.dialer !== dialer && this.#hostIdOf(existing.dialer) < this.#hostIdOf(dialer);
      if (keepOld) {
        session.close(1000, "a session is already up");
        return session;
      }
      existing.close(1000, "replaced");
    }
    this.#sessions.set(peer, session);
    this.#lastSync.set(peer, this.#options.clock.now());
    if (dialer === peer) this.#options.policy.presence(peer);
    session.start();
    return session;
  }

  merge(session: SyncSession, batch: readonly MeshRecord[]): MergeResult {
    const result = mergeBatch(this.#options, batch);
    for (const refusal of result.refused) {
      this.#options.log(`mesh: refused record ${refusal.hash} from ${this.#nameOf(session.peer)}: ${refusal.reason}`);
    }
    if (result.added.length > 0) this.#changed(result, session.sweeping);
    return result;
  }

  /** Resolves when a merge brings an ack signed by another member. */
  acked(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#ackWaiters.add(resolve);
    return promise;
  }

  /** Records this host produced itself outside sync (the join's admit, section 4.4): stored, then owed to all. */
  local(batch: readonly MeshRecord[]): MergeResult {
    const result = mergeBatch(this.#options, batch);
    if (result.added.length > 0) this.#changed(result, true);
    return result;
  }

  /** Signs and pushes one record of this host's own (a revoke, a leave). */
  append(draft: (prev: readonly string[]) => RecordDraft): MergeResult {
    const result = appendOwn(this.#options, draft);
    this.#changed(result, true);
    return result;
  }

  heard(peer: string, heads: readonly string[]): void {
    this.#confirmed.set(peer, heads);
  }

  ended(session: SyncSession): void {
    if (this.#sessions.get(session.peer) === session) this.#sessions.delete(session.peer);
  }

  /** Members that are owed records: their confirmed heads do not cover this host's set. */
  owed(): readonly MeshMember[] {
    const records = this.records();
    return [...this.#known.values()].filter(
      (member) =>
        member.signPub !== this.#options.self.signPub &&
        this.rules.missingFor(records, this.#confirmed.get(member.signPub) ?? []).length > 0,
    );
  }

  /** The dial policy's wake-up: deliver what the member is owed. */
  due(signPub: string, reason: DueReason): void {
    const member = this.#known.get(signPub);
    if (member === undefined || this.#holdBack.has(signPub)) return;
    if (reason === "probe" || this.owed().includes(member))
      void this.sync(member, reason === "probe" ? "probe" : "push");
  }

  /** This host's uplink answered again; after a drop of more than 2 minutes it sweeps with one member. */
  uplinkReturned(downMs: number): void {
    const others = this.#members();
    this.#options.policy.uplinkReturned(others.map((member) => member.signPub));
    if (downMs <= this.#timings.sweepAfterDownMs) return;
    const recent = others.toSorted(
      (a, b) => (this.#lastSync.get(b.signPub) ?? -1) - (this.#lastSync.get(a.signPub) ?? -1),
    );
    void this.#sweep(recent);
  }

  async sync(member: MeshMember, purpose: DialPurpose): Promise<boolean> {
    const open = this.#sessions.get(member.signPub);
    if (open !== undefined && !open.closed) {
      open.flush();
      return true;
    }
    const grant = await this.#options.policy.acquire(member.signPub, purpose);
    if (!grant.ok) return false;
    try {
      const channel = await this.#options.dial(member);
      this.#options.policy.report(member.signPub, "connected");
      this.attach(member.signPub, this.#options.self.signPub, channel, purpose === "sweep" || purpose === "probe");
      return true;
    } catch (error) {
      const code = error instanceof Error ? closeCodeOf(error) : undefined;
      if (code === 4404 || code === 4429) this.#options.policy.report(member.signPub, code);
      this.#options.log(`mesh: sync with ${member.name} failed: ${String(error)}`);
      return false;
    }
  }

  async #sweep(candidates: readonly MeshMember[]): Promise<void> {
    for (const member of candidates) if (await this.sync(member, "sweep")) return;
  }

  /**
   * Open sessions get the new records at once (ack forwarding). Only this host's own records and what it merged in a
   * sweep are owed onwards by dialing: a pushed batch is the pusher's to deliver (section 5.3).
   */
  #changed(result: MergeResult, owedOnwards: boolean): void {
    this.#view = result.view;
    this.#remember(result.view);
    this.#options.onView?.(result.view, result);
    for (const session of this.#sessions.values()) session.flush();
    this.#noticeAcks(result);
    if (owedOnwards) this.#push(result);
  }

  #noticeAcks(result: MergeResult): void {
    const self = this.#options.self.signPub;
    const acked = result.added.some((record) => {
      const header = this.rules.headerOf(record);
      return header.type === "ack" && header.by !== self;
    });
    if (!acked) return;
    this.#releaseHeld();
    for (const resolve of this.#ackWaiters) resolve();
    this.#ackWaiters.clear();
  }

  /** Section 5.3: a revoke first; the revoked member last, after one ack came back or 10 s. */
  #push(result: MergeResult): void {
    const revoked = new Set<string>();
    for (const record of result.added) {
      const header = this.rules.headerOf(record);
      if (header.type === "revoke") for (const key of header.revokes) revoked.add(key);
    }
    const purpose: DialPurpose = revoked.size > 0 ? "revoke-push" : "push";
    for (const key of revoked) this.#holdRevoked(key);
    for (const member of this.owed()) {
      if (!this.#holdBack.has(member.signPub)) void this.sync(member, purpose);
    }
  }

  #holdRevoked(key: string): void {
    if (key === this.#options.self.signPub || this.#holdBack.has(key)) return;
    const release = (): void => {
      cancel();
      this.#holdBack.delete(key);
      const member = this.#known.get(key);
      if (member !== undefined) void this.sync(member, "push");
    };
    const cancel = this.#options.clock.after(this.#timings.revokedLastMs, release);
    this.#holdBack.set(key, release);
  }

  #releaseHeld(): void {
    for (const release of this.#holdBack.values()) release();
  }

  #armSafetyNet(): void {
    const { safetyNetMs, safetyNetJitterMs } = this.#timings;
    const delay = uniform(this.#options.random, safetyNetMs - safetyNetJitterMs, safetyNetMs + safetyNetJitterMs);
    this.#stopNet = this.#options.clock.after(delay, () => {
      const online = this.#members().filter((member) => this.#options.policy.gate(member.signPub) === undefined);
      const oldest = online.toSorted(
        (a, b) => (this.#lastSync.get(a.signPub) ?? -1) - (this.#lastSync.get(b.signPub) ?? -1),
      );
      void this.#sweep(oldest.slice(0, 1));
      this.#armSafetyNet();
    });
  }

  #members(): readonly MeshMember[] {
    return this.#view.members.filter((member) => member.signPub !== this.#options.self.signPub);
  }

  #remember(view: MeshView): void {
    for (const member of [...view.members, ...view.overCap]) this.#known.set(member.signPub, member);
  }

  #hostIdOf(signPub: string): string {
    return this.#known.get(signPub)?.hostId ?? signPub;
  }

  #nameOf(signPub: string): string {
    return this.#known.get(signPub)?.name ?? signPub;
  }
}
