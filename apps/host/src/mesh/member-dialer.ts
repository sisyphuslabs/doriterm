import { closeCodeOf } from "@doriface/crypto";
import type { MemberEntry } from "./authorize-index.ts";
import type { DialPolicy, DialPurpose } from "./dial-policy.ts";
import type { LineLink } from "./lines.ts";

export interface MemberDialerOptions {
  readonly policy: DialPolicy;
  /** Opens a sync session (`stream:"mesh"`) to a member; rejects with the close code that refused it. */
  readonly dial: (member: MemberEntry) => Promise<LineLink>;
  /** Flushes the open session with `peer`; false when none is up. */
  readonly flushOpen: (peer: string) => boolean;
  readonly attach: (member: MemberEntry, link: LineLink, sweeping: boolean) => void;
  readonly log: (line: string) => void;
}

/**
 * Syncs with a member over its open session, or dials one under the budget (section 8.2). One dial per member at a
 * time: a push, a sweep and a probe for the same member share it, and a session that came up while the dial waited
 * for a token is used instead, giving the token back.
 */
export class MemberDialer {
  readonly #options: MemberDialerOptions;
  readonly #dialing = new Map<string, Promise<boolean>>();

  constructor(options: MemberDialerOptions) {
    this.#options = options;
  }

  sync(member: MemberEntry, purpose: DialPurpose): Promise<boolean> {
    if (this.#options.flushOpen(member.signPub)) return Promise.resolve(true);
    const pending = this.#dialing.get(member.signPub);
    if (pending !== undefined) return pending;
    const dial = this.#dial(member, purpose).finally(() => this.#dialing.delete(member.signPub));
    this.#dialing.set(member.signPub, dial);
    return dial;
  }

  async #dial(member: MemberEntry, purpose: DialPurpose): Promise<boolean> {
    const { policy } = this.#options;
    const grant = await policy.acquire(member.signPub, purpose);
    if (!grant.ok) {
      const next = "nextInMs" in grant ? `, next try in ${Math.ceil(grant.nextInMs / 1000)} s` : "";
      this.#options.log(`mesh: ${purpose} to ${member.name} waits (${grant.reason}${next})`);
      return false;
    }
    if (this.#options.flushOpen(member.signPub)) {
      policy.release();
      return true;
    }
    try {
      const link = await this.#options.dial(member);
      policy.report(member.signPub, "connected");
      this.#options.attach(member, link, purpose === "sweep" || purpose === "probe");
      return true;
    } catch (error) {
      const code = error instanceof Error ? closeCodeOf(error) : undefined;
      policy.report(member.signPub, code === 4429 || code === 4412 ? code : 4404);
      this.#options.log(`mesh: sync with ${member.name} failed: ${String(error)}`);
      return false;
    }
  }
}
