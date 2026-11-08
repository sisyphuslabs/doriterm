import { JoinRefused } from "@doriface/mesh/join";

/** A join whose committed comparison waits for both people (CLEAR section 9). */
export interface PendingJoin {
  readonly nonce: string;
  readonly name: string;
  readonly hostId: string;
  readonly fingerprint: string;
  /** The joiner's Noise key, from its card. */
  readonly noisePub: string;
  /** What it joins as: a card with no kind is a machine, which is all a version 1 card could mean. */
  readonly kind: "machine" | "client";
  /** Milliseconds since the epoch: the offer's expiry, which the pending join shares. */
  readonly expiresAt: number;
  readonly code: string;
  readonly joinerConfirmed: boolean;
}

export type JoinDecision = "approved" | "denied" | "expired";

/** Offer completion also covers automatic machine joins, which have no pending comparison. */
type AdmittedJoin = Pick<PendingJoin, "name" | "hostId" | "expiresAt">;

interface Waiting {
  join: PendingJoin;
  approved: boolean;
  readonly decided: PromiseWithResolvers<JoinDecision>;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * The pending joins of this host, in memory only: they die with the offer or the host (section 10.1). The inviting
 * member approves or denies each one, on its terminal or through `mesh-approve`; `mesh pair --auto` approves without
 * asking until its offer expires.
 */
export class PendingJoins {
  readonly #waiting = new Map<string, Waiting>();
  readonly #watchers = new Set<(join: PendingJoin) => void>();
  readonly #admitted = new Set<(join: AdmittedJoin) => void>();
  #autoUntil = 0;

  /** Approves every join until `until` (the `--auto` offer's expiry); 0 turns it off. */
  setAuto(until: number): void {
    this.#autoUntil = until;
  }

  isAuto(now = Date.now()): boolean {
    return now < this.#autoUntil;
  }

  ask(join: PendingJoin, now = Date.now()): Promise<JoinDecision> {
    if (!/^\d{3} \d{3}$/.test(join.code)) throw new JoinRefused("a pending join needs its join code");
    const existing = this.#waiting.get(join.nonce);
    if (existing !== undefined) return existing.decided.promise;
    if (now >= join.expiresAt) return Promise.resolve("expired");
    const decided = Promise.withResolvers<JoinDecision>();
    const timer = setTimeout(() => this.#settle(join.nonce, "expired"), join.expiresAt - now);
    this.#waiting.set(join.nonce, { join, decided, timer, approved: join.kind === "machine" && this.isAuto(now) });
    const watchers = [...this.#watchers];
    this.#watchers.clear();
    for (const watcher of watchers) watcher(join);
    return decided.promise;
  }

  /** Calls `listener` after each admission is persisted; returns the unsubscribe. */
  onAdmitted(listener: (join: AdmittedJoin) => void): () => void {
    this.#admitted.add(listener);
    return () => {
      this.#admitted.delete(listener);
    };
  }

  /** A join was admitted (section 4.4): tells whoever follows the offer it came on. */
  admitted(join: AdmittedJoin): void {
    for (const listener of this.#admitted) listener(join);
  }

  /** Expires the pending join with this nonce: its session ended before anyone decided. */
  expire(nonce: string): boolean {
    return this.#settle(nonce, "expired");
  }

  /** Expires every pending join: the offer they came on was replaced, and they expire with it. */
  expireAll(): void {
    for (const nonce of this.#waiting.keys()) this.#settle(nonce, "expired");
  }

  /** Approves or denies the pending join with this nonce; false when there is none (decided, expired, unknown). */
  decide(nonce: string, approve: boolean, code?: string): boolean {
    const waiting = this.#waiting.get(nonce);
    if (waiting === undefined) return false;
    if (Date.now() >= waiting.join.expiresAt) {
      this.#settle(nonce, "expired");
      return false;
    }
    if (!approve) return this.#settle(nonce, "denied");
    if (code === undefined) throw new JoinRefused("update this client to approve");
    if (code !== waiting.join.code) throw new JoinRefused("the approval code does not match this join");
    waiting.approved = true;
    if (waiting.join.joinerConfirmed) this.#settle(nonce, "approved");
    return true;
  }

  confirm(nonce: string): boolean {
    const waiting = this.#waiting.get(nonce);
    if (waiting === undefined) return false;
    if (Date.now() >= waiting.join.expiresAt) {
      this.#settle(nonce, "expired");
      return false;
    }
    waiting.join = { ...waiting.join, joinerConfirmed: true };
    if (waiting.approved) this.#settle(nonce, "approved");
    return true;
  }

  list(): readonly PendingJoin[] {
    return [...this.#waiting.values()].map((waiting) => waiting.join);
  }

  /**
   * The oldest pending join, or the next one asked; this is what a foreground `mesh pair` waits on. Rejects with the
   * signal's reason once it aborts (the control connection that asked closed), and stops watching then.
   */
  next(signal?: AbortSignal): Promise<PendingJoin> {
    const [first] = this.list();
    if (first !== undefined) return Promise.resolve(first);
    const { promise, resolve, reject } = Promise.withResolvers<PendingJoin>();
    const stop = (): void => {
      this.#watchers.delete(watcher);
      reject(signal?.reason);
    };
    const watcher = (join: PendingJoin): void => {
      signal?.removeEventListener("abort", stop);
      resolve(join);
    };
    if (signal?.aborted === true) stop();
    else {
      this.#watchers.add(watcher);
      signal?.addEventListener("abort", stop, { once: true });
    }
    return promise;
  }

  /** How many `next` calls wait for a join. */
  get watching(): number {
    return this.#watchers.size;
  }

  #settle(nonce: string, decision: JoinDecision): boolean {
    const waiting = this.#waiting.get(nonce);
    if (waiting === undefined) return false;
    this.#waiting.delete(nonce);
    clearTimeout(waiting.timer);
    waiting.decided.resolve(decision);
    return true;
  }
}
