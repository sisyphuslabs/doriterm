import { base64urlEncode, closeCodeOf } from "@doriface/crypto";
import { parseRecord, type Signed, viewOf } from "@doriface/mesh";
import { type Clock, type Random, uniform } from "./clock.ts";
import { type DialPolicy, type DialPurpose, type DueReason } from "./dial-policy.ts";
import { missingSince } from "./anti-entropy.ts";
import type { MemberEntry } from "./authorize-index.ts";
import type { LineLink } from "./lines.ts";
import { type MeshView, meshViewOf, meshViewOfIndex } from "./mesh-view.ts";
import { RevokedLast } from "./revoked-last.ts";
import { appendOwn, type MergeDeps, type MergeResult, mergeBatch, type RecordDraft } from "./merge.ts";
import { type SyncHost, SyncSession } from "./sync.ts";

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
  readonly clock: Clock;
  readonly random: Random;
  readonly policy: DialPolicy;
  /** Opens a sync session (`stream:"mesh"`) to a member; rejects with the close code that refused it. */
  readonly dial: (member: MemberEntry) => Promise<LineLink>;
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
  /** This host's signPub. */
  readonly self: string;
  readonly #options: GossipOptions;
  readonly #timings: GossipTimings;
  readonly #sessions = new Map<string, SyncSession>();
  readonly #confirmed = new Map<string, readonly string[]>();
  readonly #lastSync = new Map<string, number>();
  readonly #known = new Map<string, MemberEntry>();
  readonly #revokedLast: RevokedLast;
  readonly #ackWaiters = new Set<() => void>();
  #view: MeshView;
  /** The highest `n` of this host's own key any peer's hello named (section 10.1). */
  #counterFloor = 0;
  #stopNet: () => void = () => undefined;

  constructor(options: GossipOptions) {
    this.#options = options;
    this.meshId = options.meshId;
    this.self = base64urlEncode(options.identity.sign.publicKey);
    this.#timings = options.timings ?? GOSSIP_TIMINGS;
    this.#revokedLast = new RevokedLast({
      clock: options.clock,
      waitMs: this.#timings.revokedLastMs,
      release: (key) => {
        const member = this.#known.get(key);
        if (member !== undefined) void this.sync(member, "push");
      },
    });
    this.#view = this.#storedView();
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
    this.#revokedLast.stop();
    for (const session of this.#sessions.values()) session.close(1000, "host stopping");
  }

  records(): readonly Signed[] {
    return this.#options.store.read()?.records ?? [];
  }

  /** The open sync session with `peer`, if one is up. */
  session(peer: string): SyncSession | undefined {
    const open = this.#sessions.get(peer);
    return open?.closed === false ? open : undefined;
  }

  /** An authenticated sync session, inbound or outbound; one per peer, as section 5.1 picks it. */
  attach(peer: string, dialer: string, link: LineLink, sweeping = false, waitForHello = false): SyncSession {
    const ends = { peer, dialer, sweeping };
    const session = new SyncSession(ends, link, this, this.#options.clock, this.#timings.lingerMs);
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
    session.start(waitForHello);
    return session;
  }

  merge(session: SyncSession, batch: readonly Signed[]): MergeResult {
    const result = mergeBatch(this.#deps(), batch);
    for (const refusal of result.refused) {
      this.#options.log(`mesh: refused record ${refusal.hash} from ${this.#nameOf(session.peer)}: ${refusal.reason}`);
    }
    if (result.counterBehind) {
      this.#options.log(`mesh: counter behind its records (mesh ${this.#counterFloor}): syncing before signing`);
    }
    if (result.added.length > 0) {
      this.#options.log(`mesh: merged ${result.added.length} records from ${this.#nameOf(session.peer)}`);
      this.#changed(result, session.sweeping);
    }
    return result;
  }

  /** Resolves when a merge brings an ack signed by another member. */
  acked(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#ackWaiters.add(resolve);
    return promise;
  }

  /** Records this host produced itself outside sync (the join's admit, section 4.4): stored, then owed to all. */
  local(batch: readonly Signed[]): MergeResult {
    const result = mergeBatch(this.#deps(), batch);
    if (result.added.length > 0) this.#changed(result, true);
    return result;
  }

  /** Records this host already signed through its store (a join's admit, a revoke): owed to every member. */
  stored(records: readonly Signed[]): void {
    const view = this.#storedView();
    this.#changed({ added: records, refused: [], wanted: [], ack: undefined, counterBehind: false, view }, true);
  }

  /** Signs and pushes one record of this host's own (a revoke, a leave, a rename). */
  append(draft: RecordDraft): MergeResult {
    const result = appendOwn(this.#deps(), draft);
    this.#changed(result, true);
    return result;
  }

  heard(peer: string, heads: readonly string[], n: Readonly<Record<string, number>>): void {
    this.#confirmed.set(peer, heads);
    this.#counterFloor = Math.max(this.#counterFloor, n[this.self] ?? 0);
  }

  ended(session: SyncSession): void {
    if (this.#sessions.get(session.peer) === session) this.#sessions.delete(session.peer);
  }

  /** Members that are owed records: their confirmed heads do not cover this host's set. */
  owed(): readonly MemberEntry[] {
    const records = this.records();
    return [...this.#known.values()].filter(
      (member) =>
        member.signPub !== this.self && missingSince(records, this.#confirmed.get(member.signPub) ?? []).length > 0,
    );
  }

  /** The dial policy's wake-up: deliver what the member is owed. */
  due(signPub: string, reason: DueReason): void {
    const member = this.#known.get(signPub);
    if (member === undefined || this.#revokedLast.holds(signPub)) return;
    if (reason === "probe" || this.owed().includes(member))
      void this.sync(member, reason === "probe" ? "probe" : "push");
  }

  /** This host's uplink answered again; after a drop of more than 2 minutes it sweeps with one member. */
  uplinkReturned(downMs: number): void {
    const others = this.#members();
    const downSince = this.#options.clock.now() - downMs;
    this.#options.policy.uplinkReturned(
      others.map((member) => member.signPub),
      downSince,
    );
    if (downMs <= this.#timings.sweepAfterDownMs) return;
    const recent = others.toSorted(
      (a, b) => (this.#lastSync.get(b.signPub) ?? -1) - (this.#lastSync.get(a.signPub) ?? -1),
    );
    void this.#sweep(recent);
  }

  async sync(member: MemberEntry, purpose: DialPurpose): Promise<boolean> {
    const open = this.#sessions.get(member.signPub);
    if (open !== undefined && !open.closed) {
      open.flush();
      return true;
    }
    const grant = await this.#options.policy.acquire(member.signPub, purpose);
    if (!grant.ok) return false;
    try {
      const link = await this.#options.dial(member);
      this.#options.policy.report(member.signPub, "connected");
      this.attach(member.signPub, this.self, link, purpose === "sweep" || purpose === "probe");
      return true;
    } catch (error) {
      const code = error instanceof Error ? closeCodeOf(error) : undefined;
      this.#options.policy.report(member.signPub, code === 4429 ? 4429 : 4404);
      this.#options.log(`mesh: sync with ${member.name} failed: ${String(error)}`);
      return false;
    }
  }

  async #sweep(candidates: readonly MemberEntry[]): Promise<void> {
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
    const self = this.self;
    const acked = result.added.some((record) => {
      const body = parseRecord(record);
      return body?.type === "ack" && body.by !== self;
    });
    if (!acked) return;
    this.#revokedLast.releaseAll();
    for (const resolve of this.#ackWaiters) resolve();
    this.#ackWaiters.clear();
  }

  /** Section 5.3: a revoke first; the revoked member last, after one ack came back or 10 s. */
  #push(result: MergeResult): void {
    const revoked = new Set<string>();
    for (const record of result.added) {
      const body = parseRecord(record);
      const subject = body?.type === "revoke" ? body.subject : undefined;
      if (subject !== undefined && "signPubs" in subject) for (const key of subject.signPubs) revoked.add(key);
    }
    const purpose: DialPurpose = revoked.size > 0 ? "revoke-push" : "push";
    for (const key of revoked) if (key !== this.self) this.#revokedLast.hold(key);
    for (const member of this.owed()) {
      if (!this.#revokedLast.holds(member.signPub)) void this.sync(member, purpose);
    }
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

  #storedView(): MeshView {
    const file = this.#options.store.read();
    if (file?.index !== undefined) return meshViewOfIndex(file.index);
    const records = file?.records ?? [];
    return meshViewOf(records, viewOf(records));
  }

  #deps(): GossipOptions {
    return { ...this.#options, counterFloor: this.#counterFloor };
  }

  #members(): readonly MemberEntry[] {
    return this.#view.members.filter((member) => member.signPub !== this.self);
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
