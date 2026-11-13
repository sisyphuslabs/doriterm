import type { Clock } from "./clock.ts";

/** The waits a member's gate runs on: section 8.2's probe backoff, and the reconnect grace before it (#2448). */
export interface GateLimits {
  readonly probeFirstMs: number;
  readonly probeMaxMs: number;
  readonly reconnectRetryMs: number;
  readonly reconnectGraceMs: number;
}

export interface Gate {
  /**
   * A refused dial (4404, or a dial that failed) to a member that was reached says it is reconnecting, and offline
   * once that has lasted the grace; to a member never reached it says offline at once. A 4429 says the relay limited
   * this host.
   */
  readonly cause: "reconnecting" | "offline" | "rate-limited";
  /** Refusals in a row: inside the grace while reconnecting, probes missed once offline. */
  readonly misses: number;
  readonly nextAt: number;
  /** When the last dial that set this gate failed: return from this host's own outage drops gates set during it. */
  readonly lastMissAt: number;
}

/** The probes a gate has missed: a reconnecting member's refusals inside its grace are not probes. */
const probesMissed = (gate: Gate | undefined): number =>
  gate === undefined || gate.cause === "reconnecting" ? 0 : gate.misses;

/**
 * Each member's gate and what set it. A host's relay connection is cut now and then and is back in about a second
 * (#2448), so one refusal from a member that was reached is not an offline member: it is dialed again
 * `reconnectRetryMs` after that refusal and once more when `reconnectGraceMs` ends, and gated offline, on the probe
 * backoff, only when it still refuses then. A member never reached gets no grace, so a start with offline members
 * spends no dials on retries.
 */
export class MemberGates {
  readonly #clock: Clock;
  readonly #limits: GateLimits;
  readonly #onProbeDue: (member: string) => void;
  readonly #gates = new Map<string, Gate>();
  /** Each member's first miss since it was last reached: the evidence section 8.6's 7-day unreachable flag reads. */
  readonly #firstMiss = new Map<string, number>();
  /** Members a dial or a session reached and no dial has since found offline. */
  readonly #reached = new Set<string>();

  constructor(clock: Clock, limits: GateLimits, onProbeDue: (member: string) => void) {
    this.#clock = clock;
    this.#limits = limits;
    this.#onProbeDue = onProbeDue;
  }

  get(member: string): Gate | undefined {
    return this.#gates.get(member);
  }

  /** Since when `member` has failed every dial, while that was not this host's own outage. */
  unreachableSince(member: string): number | undefined {
    return this.#firstMiss.get(member);
  }

  reached(member: string): void {
    this.#gates.delete(member);
    this.#firstMiss.delete(member);
    this.#reached.add(member);
  }

  /**
   * A dial to `member` was refused (4404) or failed. `grace` is false when the refusal itself says the member will not
   * take this host back in seconds (a 4401: it refuses this host as revoked), so it is gated offline at once (#2507).
   */
  missed(member: string, grace = true): void {
    const now = this.#clock.now();
    const gate = this.#gates.get(member);
    const first = this.#firstMiss.get(member) ?? now;
    this.#firstMiss.set(member, first);
    const graceEnd = first + this.#limits.reconnectGraceMs;
    // A 4429 says nothing about the member, so a rate-limit gate leaves the decision to whether it was reached (#2507).
    const reconnecting =
      gate === undefined || gate.cause === "rate-limited" ? this.#reached.has(member) : gate.cause === "reconnecting";
    if (grace && reconnecting && now < graceEnd) {
      const retrying = gate?.cause === "reconnecting";
      // A refusal before the pending retry keeps that retry: two dials refused at once still retry 2 s after (#2507).
      const nextAt = !retrying
        ? Math.min(now + this.#limits.reconnectRetryMs, graceEnd)
        : now < gate.nextAt
          ? gate.nextAt
          : graceEnd;
      this.#set(member, { cause: "reconnecting", misses: (retrying ? gate.misses : 0) + 1, nextAt, lastMissAt: now });
      return;
    }
    this.#reached.delete(member);
    const misses = probesMissed(gate);
    const wait = Math.min(this.#limits.probeFirstMs * 2 ** misses, this.#limits.probeMaxMs);
    this.#set(member, { cause: "offline", misses: misses + 1, nextAt: now + wait, lastMissAt: now });
  }

  /** The relay rate limited a dial to `member` (4429): it is tried again after the first probe wait. */
  rateLimited(member: string): void {
    const now = this.#clock.now();
    const misses = probesMissed(this.#gates.get(member));
    this.#set(member, { cause: "rate-limited", misses, nextAt: now + this.#limits.probeFirstMs, lastMissAt: now });
  }

  /** This host was itself offline since `downSince`: what its dials met meanwhile says nothing about the members. */
  forgetSince(downSince: number): void {
    for (const [member, gate] of this.#gates) if (gate.lastMissAt >= downSince) this.#gates.delete(member);
    for (const [member, at] of this.#firstMiss) if (at >= downSince) this.#firstMiss.delete(member);
  }

  #set(member: string, gate: Gate): void {
    this.#gates.set(member, gate);
    this.#clock.after(gate.nextAt - this.#clock.now(), () => {
      if (this.#gates.get(member) === gate) this.#onProbeDue(member);
    });
  }
}
