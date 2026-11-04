import { parseRecord, type Signed } from "@doriface/mesh";
import type { Clock } from "./clock.ts";
import { deadline } from "./deadline.ts";
import type { CounterFloor, MergeDeps, MergeResult } from "./merge.ts";

/** A claim this host's own records do not move for this long expires: the safety net's 30 s (section 10.1). */
export const CLAIM_MS = 30_000;
/** A peer whose claim expired has its claims ignored this long: the safety net's interval. */
export const CLAIM_COOLDOWN_MS = 600_000;

interface Held {
  readonly n: number;
  readonly cancel: () => void;
}

/**
 * The counters of this host's own key that peers' hellos claim (section 10.1). A claim belongs to the peer, not to a
 * session: ending, replacing or re-greeting a session neither resolves nor renews it, and neither does a `done`. It
 * resolves when this host holds its own records up to the claimed counter (an honest answer sends those first), and it
 * expires when 30 s pass without the claimer delivering one of them, after which the peer's claims are ignored for 10
 * minutes. While a claim stands this host signs nothing of its own, its automatic acks included, so its counter moves
 * only by records that arrive; an ack held back is signed once no claim stands.
 */
export class Claims {
  readonly #clock: Clock;
  readonly #own: () => number;
  readonly #nameOf: (peer: string) => string;
  readonly #log: (line: string) => void;
  /** Signs the held-back ack; true when it is still owed (the counter was behind, so the next merge signs it). */
  readonly #ack: () => boolean;
  readonly #held = new Map<string, Held>();
  readonly #ignoredUntil = new Map<string, number>();
  #ackOwed = false;

  constructor(
    clock: Clock,
    own: () => number,
    nameOf: (peer: string) => string,
    log: (line: string) => void,
    ack: () => boolean,
  ) {
    this.#clock = clock;
    this.#own = own;
    this.#nameOf = nameOf;
    this.#log = log;
    this.#ack = ack;
  }

  /** A peer's hello claims counter `n` of this host's key; true when it holds this host's own records back. */
  claim(peer: string, n: number): boolean {
    const own = this.#own();
    const now = this.#clock.now();
    for (const [key, until] of this.#ignoredUntil) if (until <= now) this.#ignoredUntil.delete(key);
    if (n <= own || this.#ignoredUntil.has(peer)) return false;
    const held = this.#held.get(peer);
    if (held === undefined) this.#hold(peer, n);
    else this.#held.set(peer, { ...held, n: Math.max(n, held.n) });
    return true;
  }

  /**
   * Runs `merge` of records from `from`: a claim this host's own counter then meets resolves, and the claim of `from`
   * runs 30 s more when this merge moved the counter toward it. Records from anyone else renew no claim, and neither
   * does a merge of `from` that brought none of this host's records.
   */
  merging<R extends Pick<MergeResult, "ack" | "ackHeld">>(from: string, merge: () => R): R {
    const before = this.#own();
    const result = merge();
    if (result.ack !== undefined) this.#ackOwed = false;
    if (result.ackHeld) this.#ackOwed = true;
    const own = this.#own();
    for (const [peer, held] of this.#held) {
      if (own >= held.n) {
        held.cancel();
        this.#held.delete(peer);
      } else if (peer === from && own > before) {
        held.cancel();
        this.#hold(peer, held.n);
      }
    }
    return result;
  }

  /** No claim stands: the ack a claim held back is signed now. */
  release(): void {
    if (this.#ackOwed && this.#held.size === 0) this.#ackOwed = this.#ack();
  }

  /** Whether `records` carry records of `self` above its own counter while a claim waits on them. */
  meets(records: readonly Signed[], self: string): boolean {
    if (this.#held.size === 0) return false;
    const own = this.#own();
    return records.some((record) => {
      const body = parseRecord(record);
      return body?.by === self && body.n > own;
    });
  }

  /** The highest claim standing, naming the peer whose it is: no record of this host's own is signed below it. */
  floor(): CounterFloor | undefined {
    let top: { readonly n: number; readonly peer: string } | undefined;
    for (const [peer, held] of this.#held) if (top === undefined || held.n > top.n) top = { n: held.n, peer };
    return top === undefined ? undefined : { n: top.n, peer: this.#nameOf(top.peer) };
  }

  /** `deps` with {@link floor} as the counter floor. */
  signing(deps: MergeDeps): MergeDeps {
    const counterFloor = this.floor();
    return counterFloor === undefined ? deps : { ...deps, counterFloor };
  }

  stop(): void {
    for (const held of this.#held.values()) held.cancel();
    this.#held.clear();
  }

  #hold(peer: string, n: number): void {
    const cancel = deadline(this.#clock, CLAIM_MS, () => {
      const top = this.#held.get(peer)?.n ?? n;
      this.#held.delete(peer);
      this.#ignoredUntil.set(peer, this.#clock.now() + CLAIM_COOLDOWN_MS);
      this.#log(
        `mesh: ${this.#nameOf(peer)} claimed counter ${top} of this host's key and sent none of those records within 30 s: its claims are ignored for 10 minutes`,
      );
      this.release();
    });
    this.#held.set(peer, { n, cancel });
  }
}
