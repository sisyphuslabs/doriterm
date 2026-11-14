import { type Clock, type Random, uniform } from "./clock.ts";
import { type Gate, MemberGates } from "./member-gates.ts";

/** Section 8.2's constants, production values. */
export const DIAL_LIMITS = {
  budget: 12,
  windowMs: 60_000,
  halvedForMs: 600_000,
  probeFirstMs: 30_000,
  probeMaxMs: 300_000,
  /** A revoked member that answers but refuses the handshake waits this long for its revoke, doubling (#2449). */
  refusedFirstMs: 3_600_000,
  refusedMaxMs: 21_600_000,
  reconnectRetryMs: 2_000,
  reconnectGraceMs: 5_000,
  presenceJitterMs: 2_000,
  addJitterMs: 5_000,
  settleMinMs: 10_000,
  settleMaxMs: 20_000,
  lineWaitMs: 10_000,
} as const;

export type DialLimits = { readonly [K in keyof typeof DIAL_LIMITS]: number };

/** The relay upgrades one `machine.add` starts: herdr's hello probe, then the line (section 8.2). */
export const ADD_UPGRADES = 2;

/** Highest priority first: a revoke push, then other pushes and sweeps, then hc lines, then probes. */
export type DialPurpose = "revoke-push" | "push" | "sweep" | "line" | "probe";
const PRIORITY: Readonly<Record<DialPurpose, number>> = { "revoke-push": 0, push: 1, sweep: 1, line: 2, probe: 3 };

export type DueReason = "presence" | "probe" | "added" | "settle" | "budget" | "pass";

export type Grant =
  | { readonly ok: true; readonly chargedAt: number | undefined }
  | { readonly ok: false; readonly reason: "reconnecting"; readonly nextInMs: number }
  | { readonly ok: false; readonly reason: "offline"; readonly misses: number; readonly nextInMs: number }
  | { readonly ok: false; readonly reason: "rate-limited"; readonly nextInMs: number }
  | { readonly ok: false; readonly reason: "refused"; readonly nextInMs: number }
  | { readonly ok: false; readonly reason: "settling"; readonly nextInMs: number }
  | { readonly ok: false; readonly reason: "budget" };

interface Waiter {
  readonly priority: number;
  readonly seq: number;
  /** The tokens it takes at once: 2 for a `machine.add` (#106), 1 for any other dial. */
  readonly need: number;
  readonly resolve: (grant: Grant) => void;
  cancel: () => void;
}

export interface DialPolicyOptions {
  readonly clock: Clock;
  readonly random: Random;
  /** A member should be dialed now: it showed presence, its probe is due, it was just added, or settle ended. */
  readonly onDue: (member: string, reason: DueReason) => void;
  readonly limits?: DialLimits;
}

/**
 * The mesh's dial budget (section 8.2): every relay upgrade the mesh starts is charged to one sliding window per host,
 * served by priority. After a 4404 a member is dialed again only on presence, a due probe or a sweep.
 */
export class DialPolicy {
  readonly #clock: Clock;
  readonly #random: Random;
  readonly #onDue: (member: string, reason: DueReason) => void;
  readonly #limits: DialLimits;
  readonly #charged: number[] = [];
  readonly #waiters: Waiter[] = [];
  readonly #members: MemberGates;
  readonly #present = new Set<string>();
  /** Members a dial refused for the budget, with the tokens each needs at once (2 for a machine.add, 1 for a line). */
  readonly #budgetRefused = new Map<string, number>();
  /**
   * Members whose dial met a refused relay pass (4412): due again when a new pass arrives, never gated. Each one's
   * fallback makes it due anyway after the first probe wait, in case no new pass ever comes.
   */
  readonly #passRefused = new Map<string, () => void>();
  #budgetWake: (() => void) | undefined;
  #halvedUntil = Number.NEGATIVE_INFINITY;
  #settleUntil = Number.NEGATIVE_INFINITY;
  #seq = 0;
  #wake: (() => void) | undefined;

  constructor(options: DialPolicyOptions) {
    this.#clock = options.clock;
    this.#random = options.random;
    this.#onDue = options.onDue;
    this.#limits = options.limits ?? DIAL_LIMITS;
    this.#members = new MemberGates(options.clock, this.#limits, (member) => this.#onDue(member, "probe"));
  }

  get budget(): number {
    const full = this.#limits.budget;
    return this.#clock.now() < this.#halvedUntil ? Math.floor(full / 2) : full;
  }

  gate(member: string): Gate | undefined {
    return this.#members.get(member);
  }

  /** Dials waiting for a budget token: status `budget.waiting`. */
  waiting(): number {
    return this.#waiters.length;
  }

  /** While a 4429 halves the budget, when that ends on this policy's clock; undefined otherwise. */
  halvedUntil(): number | undefined {
    return this.#clock.now() < this.#halvedUntil ? this.#halvedUntil : undefined;
  }

  /** Since when `member` has failed every dial, while that was not this host's own outage. */
  unreachableSince(member: string): number | undefined {
    return this.#members.unreachableSince(member);
  }

  /**
   * Asks to dial `member`. A `direct` dial is not charged; no dialer passes it while #2070 keeps every dial, the mesh
   * line's included, on the relay. A gated member is refused until its probe is due (any dial then goes as that probe)
   * unless this is a sweep; a line to a member with no presence waits for settle. `waitMs` bounds the wait for a token.
   */
  acquire(member: string, purpose: DialPurpose, options: { direct?: boolean; waitMs?: number } = {}): Promise<Grant> {
    const refused = this.#refusal(member, purpose);
    if (refused !== undefined) return Promise.resolve(refused);
    if (options.direct === true) return Promise.resolve({ ok: true, chargedAt: undefined });
    const taken = this.#take(PRIORITY[purpose], options.waitMs);
    if (purpose !== "line") return taken;
    return taken.then((grant) => {
      if (!grant.ok && grant.reason === "budget") this.#lineRefused(member);
      return grant;
    });
  }

  /**
   * The relay upgrades of one `machine.add` of `member`, taken together (#106, M-E3): herdr's probe and then the line,
   * both charged (section 8.2). Both are granted at once, waiting like a line for the window to have room for both, so
   * an add never spends a probe whose line the window then refuses; a refusal spends nothing, and the member is due
   * again once both fit.
   */
  acquireAdd(member: string): Promise<Grant> {
    const refused = this.#refusal(member, "line");
    if (refused !== undefined) return Promise.resolve(refused);
    return this.#take(PRIORITY.line, this.#limits.lineWaitMs, ADD_UPGRADES).then((grant) => {
      if (!grant.ok && grant.reason === "budget") this.#lineRefused(member, ADD_UPGRADES);
      return grant;
    });
  }

  /** Why `member` may not be dialed for `purpose` now (its gate, or the settle after an outage), if it may not. */
  #refusal(member: string, purpose: DialPurpose): Grant | undefined {
    const now = this.#clock.now();
    const gate = this.#members.get(member);
    const probeDue = gate !== undefined && now >= gate.nextAt;
    if (gate !== undefined && purpose !== "sweep" && !probeDue) {
      const nextInMs = gate.nextAt - now;
      if (gate.cause === "rate-limited") return { ok: false, reason: "rate-limited", nextInMs };
      if (gate.cause === "reconnecting") return { ok: false, reason: "reconnecting", nextInMs };
      if (gate.cause === "refused") return { ok: false, reason: "refused", nextInMs };
      return { ok: false, reason: "offline", misses: gate.misses, nextInMs };
    }
    if (purpose === "line" && !this.#present.has(member) && now < this.#settleUntil) {
      return { ok: false, reason: "settling", nextInMs: this.#settleUntil - now };
    }
    return undefined;
  }

  /**
   * A line or an add refused for the budget (herdr cannot wait past its own deadline) is due again the moment the
   * tokens it needs are free: the window slid or a dial gave its token back, and no dial of higher priority waits.
   * Until then nothing is due, so herdr is not asked to add a line that would only be refused again.
   */
  #lineRefused(member: string, need = 1): void {
    this.#budgetRefused.set(member, Math.max(need, this.#budgetRefused.get(member) ?? 0));
    this.#armBudgetWake();
  }

  #armBudgetWake(): void {
    if (this.#budgetWake !== undefined || this.#budgetRefused.size === 0) return;
    const now = this.#clock.now();
    const need = Math.max(...this.#budgetRefused.values());
    const used = this.#used();
    const free = this.#waiters.length === 0 && used + need <= this.budget;
    // The window has room for `need` once that many of the oldest charges have slid out of it.
    const freedBy = this.#charged[Math.max(0, used + need - this.budget - 1)] ?? now;
    const at = free ? now : freedBy + this.#limits.windowMs;
    this.#budgetWake = this.#clock.after(Math.max(0, at - now), () => {
      this.#budgetWake = undefined;
      const needed = Math.max(...this.#budgetRefused.values());
      if (this.#waiters.length > 0 || this.#used() + needed > this.budget) return this.#armBudgetWake();
      const members = [...this.#budgetRefused.keys()];
      this.#budgetRefused.clear();
      for (const refused of members) this.#onDue(refused, "budget");
    });
  }

  /**
   * A granted dial that was not needed after all (a session came up while it waited) gives its own token back: the
   * charge made when it was granted, so the window's expiry stays exact.
   */
  release(chargedAt: number | undefined): void {
    const index = chargedAt === undefined ? -1 : this.#charged.indexOf(chargedAt);
    if (index === -1) return;
    this.#charged.splice(index, 1);
    this.#serve();
  }

  /**
   * What a dial ended with: connected, the relay rate limited it (4429), it failed (4404, or any error without a
   * close code: a timeout or a dropped connection), which gates the member until presence or its probe (a member that
   * was reached is first reconnecting for 5 s, #2448), or the relay
   * refused this host's pass (4412, contract v1.6), which says nothing about the member: no gate, no halving, and the
   * member is due again once a new pass arrives, or after the first probe wait (30 s) if none does. `refused`: a
   * revoked member answered and refused the handshake, gated on its own long backoff until presence (#2449).
   */
  report(member: string, outcome: "connected" | 4404 | 4412 | 4429 | "refused"): void {
    const now = this.#clock.now();
    if (outcome === "connected") {
      this.#members.reached(member);
      return;
    }
    if (outcome === "refused") {
      this.#members.refused(member);
      return;
    }
    if (outcome === 4412) {
      if (this.#passRefused.has(member)) return;
      const fallback = this.#clock.after(this.#limits.probeFirstMs, () => {
        if (this.#passRefused.delete(member)) this.#onDue(member, "pass");
      });
      this.#passRefused.set(member, fallback);
      return;
    }
    if (outcome === 4429) {
      this.#halvedUntil = now + this.#limits.halvedForMs;
      this.#members.rateLimited(member);
      return;
    }
    this.#members.missed(member);
  }

  /** This host has a new relay pass: members whose dials met a refused pass are due now. */
  passRenewed(): void {
    const members = [...this.#passRefused];
    this.#passRefused.clear();
    for (const [member, cancel] of members) {
      cancel();
      this.#onDue(member, "pass");
    }
  }

  /** Any authenticated session from `member` proves it is online: ungate it and dial after 0-2 s. */
  presence(member: string): void {
    this.#members.reached(member);
    this.#present.add(member);
    this.#clock.after(uniform(this.#random, 0, this.#limits.presenceJitterMs), () => this.#onDue(member, "presence"));
  }

  /** A newly admitted member is added after 0-5 s. */
  added(member: string): void {
    this.#clock.after(uniform(this.#random, 0, this.#limits.addJitterMs), () => this.#onDue(member, "added"));
  }

  /**
   * This host's uplink answered after a drop that began at `downSince`. The misses it saw while it was itself offline
   * say nothing about the members, so the gates they set go, and so does a first miss inside the drop. Gates set
   * before the drop stay, with their backoff. Members without presence are dialed after a 10-20 s settle: the members
   * at its end, so one admitted meanwhile is not left to a later probe.
   */
  uplinkReturned(members: () => readonly string[], downSince: number): void {
    const delay = uniform(this.#random, this.#limits.settleMinMs, this.#limits.settleMaxMs);
    this.#settleUntil = this.#clock.now() + delay;
    this.#present.clear();
    this.#members.forgetSince(downSince);
    this.#clock.after(delay, () => {
      for (const member of members()) if (!this.#present.has(member)) this.#onDue(member, "settle");
    });
  }

  #used(): number {
    const since = this.#clock.now() - this.#limits.windowMs;
    while (this.#charged.length > 0 && (this.#charged[0] ?? 0) <= since) this.#charged.shift();
    return this.#charged.length;
  }

  #take(priority: number, waitMs: number | undefined, need = 1): Promise<Grant> {
    if (this.#waiters.length === 0 && this.#used() + need <= this.budget) {
      // One reading of the clock: release() finds the charge by this exact value, and a monotonic clock never repeats.
      const chargedAt = this.#clock.now();
      for (let i = 0; i < need; i++) this.#charged.push(chargedAt);
      return Promise.resolve({ ok: true, chargedAt });
    }
    const { promise, resolve } = Promise.withResolvers<Grant>();
    const waiter: Waiter = { priority, seq: this.#seq++, need, resolve, cancel: () => undefined };
    if (waitMs !== undefined) {
      waiter.cancel = this.#clock.after(waitMs, () => {
        this.#drop(waiter);
        resolve({ ok: false, reason: "budget" });
      });
    }
    this.#waiters.push(waiter);
    this.#waiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    this.#schedule();
    return promise;
  }

  #drop(waiter: Waiter): void {
    const index = this.#waiters.indexOf(waiter);
    if (index !== -1) this.#waiters.splice(index, 1);
  }

  #serve(): void {
    this.#wake = undefined;
    while (this.#waiters.length > 0 && this.#used() + (this.#waiters[0]?.need ?? 1) <= this.budget) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) break;
      waiter.cancel();
      const chargedAt = this.#clock.now();
      for (let i = 0; i < waiter.need; i++) this.#charged.push(chargedAt);
      waiter.resolve({ ok: true, chargedAt });
    }
    this.#schedule();
    this.#budgetWake?.();
    this.#budgetWake = undefined;
    this.#armBudgetWake();
  }

  #schedule(): void {
    if (this.#waiters.length === 0 || this.#wake !== undefined) return;
    const oldest = this.#charged[0] ?? this.#clock.now();
    const at = Math.max(0, oldest + this.#limits.windowMs - this.#clock.now());
    this.#wake = this.#clock.after(at, () => this.#serve());
  }
}
