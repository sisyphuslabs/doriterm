import { type Clock, type Random, uniform } from "./clock.ts";

/** Section 8.2's constants, production values. */
export const DIAL_LIMITS = {
  budget: 12,
  windowMs: 60_000,
  halvedForMs: 600_000,
  probeFirstMs: 30_000,
  probeMaxMs: 300_000,
  presenceJitterMs: 2_000,
  addJitterMs: 5_000,
  settleMinMs: 10_000,
  settleMaxMs: 20_000,
  lineWaitMs: 10_000,
} as const;

export type DialLimits = { readonly [K in keyof typeof DIAL_LIMITS]: number };

/** Highest priority first: a revoke push, then other pushes and sweeps, then hc lines, then probes. */
export type DialPurpose = "revoke-push" | "push" | "sweep" | "line" | "probe";
const PRIORITY: Readonly<Record<DialPurpose, number>> = { "revoke-push": 0, push: 1, sweep: 1, line: 2, probe: 3 };

export type DueReason = "presence" | "probe" | "added" | "settle";

export type Grant =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "offline"; readonly misses: number; readonly nextInMs: number }
  | { readonly ok: false; readonly reason: "settling"; readonly nextInMs: number }
  | { readonly ok: false; readonly reason: "budget" };

export interface Gate {
  readonly misses: number;
  readonly nextAt: number;
}

interface Waiter {
  readonly priority: number;
  readonly seq: number;
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
  readonly #gates = new Map<string, Gate>();
  readonly #present = new Set<string>();
  #halvedUntil = Number.NEGATIVE_INFINITY;
  #settleUntil = Number.NEGATIVE_INFINITY;
  #seq = 0;
  #wake: (() => void) | undefined;

  constructor(options: DialPolicyOptions) {
    this.#clock = options.clock;
    this.#random = options.random;
    this.#onDue = options.onDue;
    this.#limits = options.limits ?? DIAL_LIMITS;
  }

  get budget(): number {
    const full = this.#limits.budget;
    return this.#clock.now() < this.#halvedUntil ? Math.floor(full / 2) : full;
  }

  gate(member: string): Gate | undefined {
    return this.#gates.get(member);
  }

  /**
   * Asks to dial `member`. A direct (LAN) dial is not charged. A gated member is refused unless this is its due probe
   * or a sweep; a line to a member with no presence waits for settle. `waitMs` bounds the wait for a token.
   */
  acquire(member: string, purpose: DialPurpose, options: { direct?: boolean; waitMs?: number } = {}): Promise<Grant> {
    const now = this.#clock.now();
    const gate = this.#gates.get(member);
    const probing = purpose === "probe" && gate !== undefined && now >= gate.nextAt;
    if (gate !== undefined && purpose !== "sweep" && !probing) {
      return Promise.resolve({ ok: false, reason: "offline", misses: gate.misses, nextInMs: gate.nextAt - now });
    }
    if (purpose === "line" && !this.#present.has(member) && now < this.#settleUntil) {
      return Promise.resolve({ ok: false, reason: "settling", nextInMs: this.#settleUntil - now });
    }
    if (options.direct === true) return Promise.resolve({ ok: true });
    return this.#take(PRIORITY[purpose], options.waitMs);
  }

  /** What a dial ended with: connected, the member is offline (4404), or the relay rate limited (4429). */
  report(member: string, outcome: "connected" | 4404 | 4429): void {
    const now = this.#clock.now();
    if (outcome === "connected") {
      this.#gates.delete(member);
      return;
    }
    if (outcome === 4429) {
      this.#halvedUntil = now + this.#limits.halvedForMs;
      this.#setGate(member, this.#gates.get(member)?.misses ?? 0, now + this.#limits.probeFirstMs);
      return;
    }
    const misses = (this.#gates.get(member)?.misses ?? 0) + 1;
    const wait = Math.min(this.#limits.probeFirstMs * 2 ** (misses - 1), this.#limits.probeMaxMs);
    this.#setGate(member, misses, now + wait);
  }

  /** Any authenticated session from `member` proves it is online: ungate it and dial after 0-2 s. */
  presence(member: string): void {
    this.#gates.delete(member);
    this.#present.add(member);
    this.#clock.after(uniform(this.#random, 0, this.#limits.presenceJitterMs), () => this.#onDue(member, "presence"));
  }

  /** A newly admitted member is added after 0-5 s. */
  added(member: string): void {
    this.#clock.after(uniform(this.#random, 0, this.#limits.addJitterMs), () => this.#onDue(member, "added"));
  }

  /**
   * This host's uplink answered after a drop. The 4404s it saw while it was itself offline say nothing about the
   * members, so their gates go; members without presence are dialed after a 10-20 s settle.
   */
  uplinkReturned(members: readonly string[]): void {
    const delay = uniform(this.#random, this.#limits.settleMinMs, this.#limits.settleMaxMs);
    this.#settleUntil = this.#clock.now() + delay;
    this.#present.clear();
    this.#gates.clear();
    this.#clock.after(delay, () => {
      for (const member of members) if (!this.#present.has(member)) this.#onDue(member, "settle");
    });
  }

  #setGate(member: string, misses: number, nextAt: number): void {
    this.#gates.set(member, { misses, nextAt });
    this.#clock.after(nextAt - this.#clock.now(), () => {
      if (this.#gates.get(member)?.nextAt === nextAt) this.#onDue(member, "probe");
    });
  }

  #used(): number {
    const since = this.#clock.now() - this.#limits.windowMs;
    while (this.#charged.length > 0 && (this.#charged[0] ?? 0) <= since) this.#charged.shift();
    return this.#charged.length;
  }

  #take(priority: number, waitMs: number | undefined): Promise<Grant> {
    if (this.#waiters.length === 0 && this.#used() < this.budget) {
      this.#charged.push(this.#clock.now());
      return Promise.resolve({ ok: true });
    }
    const { promise, resolve } = Promise.withResolvers<Grant>();
    const waiter: Waiter = { priority, seq: this.#seq++, resolve, cancel: () => undefined };
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
    while (this.#waiters.length > 0 && this.#used() < this.budget) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) break;
      waiter.cancel();
      this.#charged.push(this.#clock.now());
      waiter.resolve({ ok: true });
    }
    this.#schedule();
  }

  #schedule(): void {
    if (this.#waiters.length === 0 || this.#wake !== undefined) return;
    const oldest = this.#charged[0] ?? this.#clock.now();
    const at = Math.max(0, oldest + this.#limits.windowMs - this.#clock.now());
    this.#wake = this.#clock.after(at, () => this.#serve());
  }
}
