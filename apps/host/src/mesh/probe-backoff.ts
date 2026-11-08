import type { Clock } from "./clock.ts";
import { DIAL_LIMITS } from "./dial-policy.ts";

/**
 * Members whose add failed with herdr's retryable kinds, on section 8.2's probe backoff: retried 30 s later, doubling
 * to 5 minutes, or at once on the member's presence. An add refused for the dial budget is retried on the policy's
 * budget event alone, the moment the tokens it needs are free (section 8.2): it says nothing about the member, so it
 * neither waits on nor adds to that backoff. `fire` runs when one is due; a member that is added, leaves the view or
 * the host stops is cleared.
 */
export class ProbeBackoff {
  readonly #clock: Clock;
  readonly #fire: () => void;
  /** Budget and presence wakes received during the current member attempt, before its RPC refusal has arrived. */
  readonly #during = new Map<string, { budget: boolean; present: boolean }>();
  readonly #retries = new Map<
    string,
    {
      readonly attempts: number;
      readonly until: number;
      readonly due: boolean;
      /** Not a budget refusal: the member's presence answers it (section 8.2), so presence releases the wait. */
      readonly reach: boolean;
      readonly cancel: () => void;
    }
  >();

  constructor(clock: Clock, fire: () => void) {
    this.#clock = clock;
    this.#fire = fire;
  }

  begin(hostId: string): void {
    this.#during.set(hostId, { budget: false, present: false });
  }

  /** The member's add was refused: `reach` for a reachability refusal, false for the dial budget's. */
  later(hostId: string, reach = true): void {
    const previous = this.#retries.get(hostId);
    previous?.cancel();
    const during = this.#during.get(hostId);
    this.#during.delete(hostId);
    const now = this.#clock.now();
    if (!reach) {
      // Only the policy's budget event releases it; a timer alone would dial a still-full budget. One that arrived
      // while this attempt was in flight already said the tokens are free.
      const due = during?.budget === true;
      const cancel = due ? this.#clock.after(0, this.#fire) : () => {};
      this.#retries.set(hostId, { attempts: previous?.attempts ?? 0, until: now, due, reach, cancel });
      return;
    }
    const attempts = (previous?.attempts ?? 0) + 1;
    // A presence seen while this attempt was in flight is newer than the reachability it failed on: retry at once.
    const wait =
      during?.present === true ? 0 : Math.min(DIAL_LIMITS.probeFirstMs * 2 ** (attempts - 1), DIAL_LIMITS.probeMaxMs);
    const cancel = this.#clock.after(wait, this.#fire);
    this.#retries.set(hostId, { attempts, until: now + wait, due: true, reach, cancel });
  }

  /**
   * Every reconcile source observes the member's wait, a view change and another member's retry among them; only the
   * member's presence ends a reachability wait early (`present`), and only the budget event a budget wait.
   */
  ready(hostId: string): boolean {
    const retry = this.#retries.get(hostId);
    return retry === undefined || (retry.due && this.#clock.now() >= retry.until);
  }

  /** The policy's token-availability event: it releases a budget wait, and nothing else does. */
  budgetAvailable(hostId: string): void {
    const during = this.#during.get(hostId);
    if (during !== undefined) {
      during.budget = true;
      return;
    }
    const retry = this.#retries.get(hostId);
    if (retry === undefined || retry.due) return;
    this.#retries.set(hostId, { ...retry, due: true });
  }

  /**
   * The member showed presence (an authenticated session from it): it is reachable now, so a retry a reachability
   * refusal armed is due at once, as section 8.2 redials a 4404 member on presence. The attempt count stays, so a member
   * that is present but still refused keeps doubling its timer; a budget wait is left to the budget's own event.
   */
  present(hostId: string): void {
    const during = this.#during.get(hostId);
    if (during !== undefined) {
      during.present = true;
      return;
    }
    const retry = this.#retries.get(hostId);
    if (retry === undefined || !retry.reach) return;
    retry.cancel();
    this.#retries.set(hostId, { ...retry, until: this.#clock.now(), due: true, cancel: () => {} });
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
