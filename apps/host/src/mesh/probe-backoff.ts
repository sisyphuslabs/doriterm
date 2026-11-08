import type { Clock } from "./clock.ts";
import { DIAL_LIMITS } from "./dial-policy.ts";

/**
 * Members whose add failed with herdr's retryable kinds, on section 8.2's probe backoff: retried 30 s later, doubling
 * to 5 minutes. `fire` runs when one is due; a member that is added, leaves the view or the host stops is cleared.
 */
export class ProbeBackoff {
  readonly #clock: Clock;
  readonly #fire: () => void;
  /** A budget wake received during the current member attempt, before its RPC refusal has arrived. */
  readonly #during = new Map<string, boolean>();
  readonly #retries = new Map<
    string,
    { readonly attempts: number; readonly until: number; readonly due: boolean; readonly cancel: () => void }
  >();

  constructor(clock: Clock, fire: () => void) {
    this.#clock = clock;
    this.#fire = fire;
  }

  begin(hostId: string): void {
    this.#during.set(hostId, false);
  }

  later(hostId: string, wake = true): void {
    const attempts = (this.#retries.get(hostId)?.attempts ?? 0) + 1;
    this.#retries.get(hostId)?.cancel();
    const wait = Math.min(DIAL_LIMITS.probeFirstMs * 2 ** (attempts - 1), DIAL_LIMITS.probeMaxMs);
    const due = wake || this.#during.get(hostId) === true;
    this.#during.delete(hostId);
    this.#retries.set(hostId, {
      attempts,
      until: this.#clock.now() + wait,
      due,
      // Budget refusals wait for the policy's token-availability event; a timer alone would dial a still-full budget.
      cancel: due ? this.#clock.after(wait, this.#fire) : () => {},
    });
  }

  /** Every reconcile source observes the same deadline, including presence and budget notifications. */
  ready(hostId: string): boolean {
    const retry = this.#retries.get(hostId);
    return retry === undefined || (retry.due && this.#clock.now() >= retry.until);
  }

  /** Only the policy's token-availability event releases a budget wait; unrelated reconciles never arm its timer. */
  budgetAvailable(hostId: string): void {
    if (this.#during.has(hostId)) {
      this.#during.set(hostId, true);
      return;
    }
    const retry = this.#retries.get(hostId);
    if (retry === undefined || retry.due) return;
    retry.cancel();
    this.#retries.set(hostId, {
      ...retry,
      due: true,
      cancel:
        this.#clock.now() < retry.until ? this.#clock.after(retry.until - this.#clock.now(), this.#fire) : () => {},
    });
  }

  clear(hostId: string): void {
    this.#retries.get(hostId)?.cancel();
    this.#retries.delete(hostId);
    this.#during.delete(hostId);
  }

  /** Clears every member that `keep` rejects (all of them when it is omitted). */
  clearExcept(keep: (hostId: string) => boolean = () => false): void {
    for (const hostId of this.#retries.keys()) if (!keep(hostId)) this.clear(hostId);
    for (const hostId of this.#during.keys()) if (!keep(hostId)) this.#during.delete(hostId);
  }
}
