import { type ByteLink, closeCodeOf } from "@doriface/crypto";
import { type Clock, monotonicClock } from "./clock.ts";
import { ADD_UPGRADES, DIAL_LIMITS, type DialPolicy, type Grant } from "./dial-policy.ts";
import type { MemberEntry } from "./authorize-index.ts";
import type { MeshView } from "./mesh-view.ts";
import { NoUplinkError } from "./no-uplink.ts";

/** The bridge's refusal when no dial token freed in time; the reconciler re-adds on the budget's due, not a backoff. */
export const BUDGET_REFUSAL = "waiting for the dial budget";

const REVOKED = "revoked from the mesh";

export type LineGrant =
  | { readonly ok: true; readonly link: ByteLink }
  | { readonly ok: false; readonly code: number; readonly reason: string };

type Refusal = { readonly ok: false; readonly code: number; readonly reason: string };

/**
 * Both upgrades of a `machine.add` taken ahead, for the member's next grants within ADD_RESERVATION_MS; `failed` gives
 * back what a failed add left undialed, since herdr dials no line after a failed add.
 */
export type AddReservation = { readonly ok: true; readonly failed: () => void } | Refusal;

/**
 * How long an add's reserved upgrades wait for herdr's grants: `machine.add` waits up to 20 s for herdr's hello probe,
 * and herdr dials the line itself right after the add returns (measured 0.2-2.2 s later on hc 0.1.17).
 */
export const ADD_RESERVATION_MS = 30_000;

export interface LineGrantsOptions {
  readonly view: () => MeshView;
  readonly policy: DialPolicy;
  /**
   * Dials the member's hc stream with this host's Noise key (section 7.2), over the relay: the dialer has no LAN or other
   * direct path, and the owner's decision (#2070) keeps every session on the relay, the mesh line included (#2284).
   */
  readonly dial: (member: MemberEntry) => Promise<ByteLink>;
  readonly waitMs?: number;
  /** Times the reservations out; the policy's own clock in the running host. */
  readonly clock?: Clock;
  readonly log?: (line: string) => void;
}

const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

/**
 * The running host's side of `connect --mesh` (section 7.2): a grant checks the member, applies the dial policy,
 * dials, and keeps the line registered under the member's key, so a revocation closes outbound lines too (4401).
 */
export class LineGrants {
  readonly #options: LineGrantsOptions;
  readonly #open = new Map<string, Set<ByteLink>>();
  /** Upgrades taken ahead for a member's `machine.add`, which its next grants spend instead of a token (#106). */
  readonly #reserved = new Map<
    string,
    { left: number; readonly until: number; readonly chargedAt: number | undefined }
  >();

  constructor(options: LineGrantsOptions) {
    this.#options = options;
  }

  /**
   * Takes both upgrades of a `machine.add` of `hostId` ahead (herdr's probe and the line, section 8.2), so its next two
   * grants spend them: the add starts only when the window has room for both, and a refusal spends nothing (#106,
   * M-E3). What herdr does not ask for within ADD_RESERVATION_MS is dropped; its charge leaves the window as any does.
   * A gated or settling member reserves nothing, and its add goes ahead for herdr's grant to refuse, as before.
   */
  async reserveAdd(hostId: string): Promise<AddReservation> {
    const member = this.#member(hostId);
    if (!("signPub" in member)) return member;
    // A retried add whose pair is still held (unexpired, not fully spent) reuses it rather than charging a second pair.
    const held = this.#reserved.get(member.signPub);
    if (held !== undefined && held.left > 0 && this.#now() < held.until) {
      return { ok: true, failed: () => this.#dropReserved(member.signPub) };
    }
    const grant = await this.#options.policy.acquireAdd(member.signPub);
    // Only the budget holds an add back: a gated or settling member is left to herdr's own grant, refused as before.
    if (!grant.ok)
      return grant.reason === "budget" ? this.#refused(member, grant) : { ok: true, failed: () => undefined };
    this.#reserved.set(member.signPub, {
      left: ADD_UPGRADES,
      until: this.#now() + ADD_RESERVATION_MS,
      chargedAt: grant.chargedAt,
    });
    return { ok: true, failed: () => this.#dropReserved(member.signPub) };
  }

  async grant(hostId: string): Promise<LineGrant> {
    const member = this.#member(hostId);
    if (!("signPub" in member)) return member;
    const { policy } = this.#options;
    const reserved = this.#spendReserved(member.signPub);
    const grant: Grant = reserved
      ? { ok: true, chargedAt: undefined }
      : await policy.acquire(member.signPub, "line", { waitMs: this.#options.waitMs ?? DIAL_LIMITS.lineWaitMs });
    if (!grant.ok) return this.#refused(member, grant);
    try {
      const link = await this.#options.dial(member);
      policy.report(member.signPub, "connected");
      // A revocation that landed while this dial was in flight already ran closeRevoked, which could not see this line.
      const now = this.#member(hostId);
      if (!("signPub" in now) || now.signPub !== member.signPub) {
        this.#options.log?.(`mesh: close code=4401 source=line-grant-race: ${REVOKED}`);
        link.close(4401, REVOKED);
        return "signPub" in now ? { ok: false, code: 4401, reason: "not a member of this mesh" } : now;
      }
      this.#register(member.signPub, link);
      return { ok: true, link };
    } catch (error) {
      if (error instanceof NoUplinkError) {
        if (reserved) {
          // No relay upgrade happened: the reserved token this grant took goes back with the rest.
          policy.release(this.#reserved.get(member.signPub)?.chargedAt);
          this.#dropReserved(member.signPub);
        }
        policy.release(grant.chargedAt);
        return { ok: false, code: 4404, reason: error.message };
      }
      if (reserved) this.#dropReserved(member.signPub);
      const code = error instanceof Error ? closeCodeOf(error) : undefined;
      policy.report(member.signPub, code === 4429 || code === 4412 || code === 4401 ? code : 4404);
      return {
        ok: false,
        code: code ?? 4404,
        reason: `${member.name}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** Spends one of the member's reserved upgrades, if it has one that has not timed out. */
  #spendReserved(key: string): boolean {
    const reserved = this.#reserved.get(key);
    if (reserved === undefined) return false;
    if (reserved.left === 0 || this.#now() >= reserved.until) {
      this.#dropReserved(key);
      return false;
    }
    reserved.left -= 1;
    return true;
  }

  /**
   * Drops a member's reservation and gives back the tokens no dial used: a reserved token that was never dialed was no
   * relay upgrade, so it leaves the window at once (section 8.2 charges every upgrade, and only those).
   */
  #dropReserved(key: string): void {
    const reserved = this.#reserved.get(key);
    this.#reserved.delete(key);
    for (let i = 0; i < (reserved?.left ?? 0); i++) this.#options.policy.release(reserved?.chargedAt);
  }

  #now(): number {
    return (this.#options.clock ?? monotonicClock).now();
  }

  #member(hostId: string): MemberEntry | Refusal {
    const view = this.#options.view();
    const member = view.members.find((entry) => entry.hostId === hostId);
    return member ?? { ok: false, code: 4401, reason: "not a member of this mesh" };
  }

  #refused(member: MemberEntry, grant: Exclude<Grant, { readonly ok: true }>): Refusal {
    if (grant.reason === "budget") return { ok: false, code: 4429, reason: BUDGET_REFUSAL };
    const next = seconds(grant.nextInMs);
    if (grant.reason === "settling")
      return {
        ok: false,
        code: 4404,
        reason: `${member.name}: the mesh settles for ${next} s after this host reconnected`,
      };
    if (grant.reason === "rate-limited") {
      const reason = `${member.name}: the relay is rate limiting this host (4429); next try in ${next} s`;
      return { ok: false, code: 4429, reason };
    }
    if (grant.reason === "reconnecting")
      return { ok: false, code: 4404, reason: `${member.name} is reconnecting; next try in ${next} s` };
    if (grant.reason === "refused") {
      return { ok: false, code: 4404, reason: `${member.name} refused this host's handshake; next try in ${next} s` };
    }
    return {
      ok: false,
      code: 4404,
      reason: `${member.name} is offline (4404 ×${grant.misses}); next try in ${next} s`,
    };
  }

  closeRevoked(view: MeshView): void {
    const current = new Set(view.members.map((member) => member.signPub));
    for (const [key, links] of this.#open) {
      if (current.has(key)) continue;
      for (const link of links) {
        this.#options.log?.(`mesh: close code=4401 source=line-revocation: ${REVOKED}`);
        link.close(4401, REVOKED);
      }
    }
  }

  #register(key: string, link: ByteLink): void {
    const links = this.#open.get(key) ?? new Set();
    links.add(link);
    this.#open.set(key, links);
    link.onClose(() => {
      links.delete(link);
      if (links.size === 0 && this.#open.get(key) === links) this.#open.delete(key);
    });
  }
}
