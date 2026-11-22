import { base64urlEncode } from "@doriface/crypto";
import type { Signed } from "@doriface/mesh";
import type { Clock, Random } from "./clock.ts";
import { type DialPolicy, type DialPurpose, type DueReason } from "./dial-policy.ts";
import { ownN } from "../state/mesh-tx.ts";
import type { MemberEntry } from "./authorize-index.ts";
import type { MeshStore } from "../state/mesh.ts";
import type { LineLink } from "./lines.ts";
import type { MeshView } from "./mesh-view.ts";
import { MemberDialer } from "./member-dialer.ts";
import { machinesOf } from "./mesh-view.ts";
import { MemberBook, StoredMesh } from "./stored-mesh.ts";
import { RevokedLast } from "./revoked-last.ts";
import { Claims } from "./claims.ts";
import { Confirmed } from "./confirmed.ts";
import { FormatAnswers } from "./format-answers.ts";
import type { FormatSupport } from "./format-readiness.ts";
import { retireIfGone, revokedBy } from "./revocation.ts";
import { Sweeps } from "./sweeps.ts";
import {
  ackAdmission,
  appendOwn,
  type MergeDeps,
  type MergeResult,
  mergeBatch,
  owesAck,
  owesAdmission,
  type RecordDraft,
} from "./merge.ts";
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
  readonly store: MergeDeps["store"] & Pick<MeshStore, "authorizeIndex">;
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
  readonly #stored: StoredMesh;
  readonly #claims: Claims;
  readonly #dialer: MemberDialer;
  readonly #sessions = new Map<string, SyncSession>();
  readonly #confirmed = new Confirmed(() => this.records());
  readonly #formats = new FormatAnswers();
  readonly #lastSync = new Map<string, number>();
  readonly #sweeps: Sweeps;
  readonly #known = new MemberBook();
  readonly #revokedLast: RevokedLast;
  /** Revoked members whose released revoke push did not get through yet: retried as a revoke push when they are due. */
  readonly #revokeOwed = new Set<string>();
  #view: MeshView;

  constructor(options: GossipOptions) {
    this.#options = options;
    this.#stored = new StoredMesh(options.store);
    this.#dialer = new MemberDialer({
      policy: options.policy,
      dial: options.dial,
      flushOpen: (peer) => this.#flushOpen(peer),
      attach: (member, link, sweeping) => void this.attach(member.signPub, this.self, link, sweeping),
      revoked: (member) => this.#view.revoked.includes(member),
      log: options.log,
    });
    this.meshId = options.meshId;
    this.self = base64urlEncode(options.identity.sign.publicKey);
    this.#timings = options.timings ?? GOSSIP_TIMINGS;
    this.#revokedLast = new RevokedLast({
      clock: options.clock,
      waitMs: this.#timings.revokedLastMs,
      release: (key) => {
        const member = this.#known.get(key);
        if (member === undefined || !this.owed().includes(member)) return;
        this.#revokeOwed.add(key);
        void this.sync(member, "revoke-push");
      },
    });
    this.#sweeps = new Sweeps({
      ...options,
      timings: this.#timings,
      members: () => this.#members(),
      lastSync: (signPub) => this.#lastSync.get(signPub),
      sync: (member, purpose) => this.sync(member, purpose),
    });
    const own = (): number => ownN(this.records(), this.self);
    const ack = (): boolean => {
      const result = mergeBatch(options, [], true);
      if (result.added.length > 0) this.#changed(result, true);
      return result.counterBehind;
    };
    const admit = (): void => {
      const admitted = ackAdmission(this.#claims.signing(options));
      if (admitted !== undefined) this.#changed(admitted, true);
    };
    this.#claims = new Claims(
      options.clock,
      own,
      (peer) => this.#known.nameOf(peer),
      options.log,
      ack,
      admit,
      () => owesAck(options),
    );
    this.#claims.recheckAckOnce();
    this.#view = this.#stored.view();
    this.#known.remember(this.#view);
  }

  get view(): MeshView {
    return this.#view;
  }

  start(): void {
    this.#sweeps.start();
  }

  /**
   * The joiner's ack of its own admission (section 5.5), once, owed to every member. It is signed once a member's hello
   * has been read (or none answered within a claim's wait) and no claim stands (#159); true when this made it owed.
   */
  ackAdmission(): boolean {
    if (!owesAdmission(this.#options)) return false;
    return this.#claims.oweAdmission();
  }

  stop(): void {
    this.#sweeps.stop();
    this.#revokedLast.stop();
    this.#claims.stop();
    for (const session of this.#sessions.values()) session.close(1000, "host stopping");
  }

  records(): readonly Signed[] {
    return this.#stored.records();
  }

  /** When this host last had a sync session with `peer`, on this host's clock. */
  lastSync(peer: string): number | undefined {
    return this.#lastSync.get(peer);
  }

  /**
   * The highest counter of this host's key that a standing claim holds (section 10.1), 0 when none stands: a claim that
   * resolved, expired or is ignored in its cooldown no longer counts, so status shows only what holds signing back (#151).
   */
  get peerCounter(): number {
    return this.#claims.floor()?.n ?? 0;
  }

  /** A member refused this host's sync dial with 4401: this host may be revoked (section 8.6). */
  get possiblyRevoked(): boolean {
    return this.#dialer.refusedAsRevoked > 0;
  }

  /** How many stored records `peer` is not known to hold. */
  owedCount(peer: string): number {
    return this.#confirmed.owedCount(peer);
  }

  /** The open sync session with `peer`, if one is up. */
  session(peer: string): SyncSession | undefined {
    const open = this.#sessions.get(peer);
    return open?.closed === false ? open : undefined;
  }

  /** An authenticated sync session, inbound or outbound; one per peer, as section 5.1 picks it. */
  attach(peer: string, dialer: string, link: LineLink, sweeping = false, waitForHello = false): SyncSession {
    const ends = { peer, dialer, sweeping };
    const session = new SyncSession(ends, link, this, this.#options.clock, this.#timings.lingerMs, this.#options.log);
    const existing = this.#sessions.get(peer);
    if (existing !== undefined && !existing.closed) {
      const keepOld =
        existing.dialer !== dialer && this.#known.hostIdOf(existing.dialer) < this.#known.hostIdOf(dialer);
      if (keepOld) {
        session.close(1000, "a session is already up");
        return session;
      }
      existing.close(1000, "replaced");
    }
    this.#sessions.set(peer, session);
    this.#dialer.accepted(peer);
    this.#lastSync.set(peer, this.#options.clock.now());
    if (dialer === peer) this.#options.policy.presence(peer);
    session.start(waitForHello);
    retireIfGone(session, this.#view, this.self);
    return session;
  }

  merge(session: SyncSession, batch: readonly Signed[]): MergeResult {
    const result = this.#claims.merging(session.peer, () => mergeBatch(this.#claims.signing(this.#options), batch));
    this.#confirmed.sent(session.peer, batch);
    for (const refusal of result.refused) {
      this.#options.log(
        `mesh: refused record ${refusal.hash} from ${this.#known.nameOf(session.peer)}: ${refusal.reason}`,
      );
    }
    if (result.counterBehind) {
      this.#options.log(
        "mesh: counter behind its own records (a restored backup): caught up, signing from the next merge",
      );
    }
    if (result.added.length > 0) {
      this.#options.log(`mesh: merged ${result.added.length} records from ${this.#known.nameOf(session.peer)}`);
      this.#changed(result, session.sweeping);
    }
    this.#claims.release();
    return result;
  }

  /** Records this host already signed through its store (a join's admit, a revoke): owed to every member. */
  stored(records: readonly Signed[]): void {
    const view = this.#stored.view();
    const result = { added: records, refused: [], wanted: [], ack: undefined, counterBehind: false, ackHeld: false };
    this.#changed({ ...result, view }, true);
  }

  /** What every member has said it reads, for the writer-side gate before a client admission is signed. */
  formatAnswers(): readonly FormatSupport[] {
    return this.#formats.all();
  }

  /** The highest claim a peer's `hello` holds on this host's counter (section 10.1); the operator commands check it. */
  floor(): ReturnType<Claims["floor"]> {
    return this.#claims.floor();
  }

  /** Signs and pushes one record of this host's own (a revoke, a leave, a rename). */
  append(draft: RecordDraft): MergeResult {
    const result = appendOwn(this.#claims.signing(this.#options), draft);
    this.#changed(result, true);
    return result;
  }

  /**
   * A peer's `hello`: the heads it holds, and the highest counter it holds of this host's own key. Above this host's
   * own, it signs no own record below that counter (section 10.1) until those records arrive (see Claims); true when
   * that holds them back, so the peer owes a `done` like an answer.
   */
  heard(
    peer: string,
    heads: readonly string[],
    n: Readonly<Record<string, number>>,
    reads: readonly number[] | undefined,
  ): boolean {
    this.#confirmed.heard(peer, heads);
    this.#formats.record(peer, reads);
    if (this.#confirmed.owedCount(peer) === 0) this.#revokeOwed.delete(peer);
    const claim = n[this.self] ?? 0;
    const holds = this.#claims.claim(peer, claim);
    if (!holds) this.#claims.release();
    return holds;
  }

  meets(records: readonly Signed[]): boolean {
    return this.#claims.meets(records, this.self);
  }

  /** The peer owed a `done` for 30 s without a line of progress: its session closes 4400 (a claim runs on). */
  overdue(session: SyncSession): void {
    if (this.#sessions.get(session.peer) !== session) return;
    this.#options.log(
      `mesh: closing the sync session with ${this.#known.nameOf(session.peer)}: no done within 30 s (4400)`,
    );
  }

  /** The heads and records `peer` is known to hold: its last `hello`, and the stored records it sent since. */
  held(peer: string): readonly string[] {
    return this.#confirmed.held(peer);
  }

  ended(session: SyncSession): void {
    if (this.#sessions.get(session.peer) === session) this.#sessions.delete(session.peer);
  }

  /**
   * Members that are owed records: their confirmed heads do not cover this host's set.
   *
   * A client that is still a member is never owed one, because it is refused on the mesh stream and could not take delivery.
   * A client that has left or been revoked is owed its revoke like anyone else, so only CURRENT clients are dropped here.
   */
  owed(): readonly MemberEntry[] {
    const clients = new Set(
      this.#view.members.filter((member) => member.kind === "client").map((member) => member.signPub),
    );
    return this.#known
      .all()
      .filter((member) => member.signPub !== this.self && !clients.has(member.signPub))
      .filter((member) => this.owedCount(member.signPub) > 0);
  }

  /** The dial policy's wake-up: deliver what the member is owed. */
  due(signPub: string, reason: DueReason): void {
    const member = this.#known.get(signPub);
    if (member === undefined || this.#revokedLast.holds(signPub)) return;
    const owed = this.owed().includes(member);
    if (!owed) this.#revokeOwed.delete(signPub);
    if (owed && this.#revokeOwed.has(signPub)) void this.sync(member, "revoke-push");
    else if (reason === "probe" || owed) void this.sync(member, reason === "probe" ? "probe" : "push");
  }

  /** This host's uplink answered again; after a drop of more than 2 minutes it sweeps with one member. */
  uplinkReturned(downMs: number): void {
    this.#sweeps.uplinkReturned(downMs);
  }

  sync(member: MemberEntry, purpose: DialPurpose): Promise<boolean> {
    return this.#dialer.sync(member, purpose);
  }

  #flushOpen(peer: string): boolean {
    const open = this.#sessions.get(peer);
    if (open === undefined || open.closed) return false;
    open.flush();
    return true;
  }

  /**
   * Open sessions get the new records at once (ack forwarding). Only this host's own records and what it merged in a
   * sweep are owed onwards by dialing: a pushed batch is the pusher's to deliver (section 5.3).
   */
  #changed(result: MergeResult, owedOnwards: boolean): void {
    this.#view = result.view;
    this.#known.remember(result.view);
    this.#formats.keep(new Set(result.view.members.map((member) => member.signPub)));
    this.#options.onView?.(result.view, result);
    for (const session of this.#sessions.values()) session.flush();
    if (owedOnwards) this.#push(result);
    for (const session of this.#sessions.values()) retireIfGone(session, this.#view, this.self);
  }

  /** Section 5.3: a revoke first; the revoked member last, after one ack came back or 10 s. */
  #push(result: MergeResult): void {
    const revoked = revokedBy(result.added);
    const purpose: DialPurpose = revoked.size > 0 ? "revoke-push" : "push";
    for (const key of revoked) if (key !== this.self) this.#revokedLast.hold(key);
    for (const member of this.owed()) {
      if (!this.#revokedLast.holds(member.signPub)) void this.sync(member, purpose);
    }
  }

  #members(): readonly MemberEntry[] {
    return machinesOf(this.#view).filter((member) => member.signPub !== this.self);
  }
}
