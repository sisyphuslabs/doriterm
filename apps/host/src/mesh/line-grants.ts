import { type ByteLink, closeCodeOf } from "@doriface/crypto";
import { DIAL_LIMITS, type DialPolicy } from "./dial-policy.ts";
import type { MemberEntry } from "./authorize-index.ts";
import type { MeshView } from "./mesh-view.ts";

/** The bridge's refusal when no dial token freed in time; the reconciler re-adds on the budget's due, not a backoff. */
export const BUDGET_REFUSAL = "waiting for the dial budget";

export type LineGrant =
  | { readonly ok: true; readonly link: ByteLink }
  | { readonly ok: false; readonly code: number; readonly reason: string };

export interface LineGrantsOptions {
  readonly view: () => MeshView;
  readonly policy: DialPolicy;
  /** Dials the member's hc stream with this host's Noise key (section 7.2), LAN first when one is known. */
  readonly dial: (member: MemberEntry) => Promise<ByteLink>;
  readonly waitMs?: number;
}

const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

/**
 * The running host's side of `connect --mesh` (section 7.2): a grant checks the member, applies the dial policy,
 * dials, and keeps the line registered under the member's key, so a revocation closes outbound lines too (4401).
 */
export class LineGrants {
  readonly #options: LineGrantsOptions;
  readonly #open = new Map<string, Set<ByteLink>>();

  constructor(options: LineGrantsOptions) {
    this.#options = options;
  }

  async grant(hostId: string): Promise<LineGrant> {
    const view = this.#options.view();
    const member = view.members.find((entry) => entry.hostId === hostId);
    if (member === undefined) {
      const capped = view.overCap.some((entry) => entry.hostId === hostId);
      const reason = capped ? `host ${hostId} is past the mesh's 12-member cap` : "not a member of this mesh";
      return { ok: false, code: 4401, reason };
    }
    const { policy } = this.#options;
    const grant = await policy.acquire(member.signPub, "line", {
      waitMs: this.#options.waitMs ?? DIAL_LIMITS.lineWaitMs,
    });
    if (!grant.ok) {
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
      return {
        ok: false,
        code: 4404,
        reason: `${member.name} is offline (4404 ×${grant.misses}); next try in ${next} s`,
      };
    }
    try {
      const link = await this.#options.dial(member);
      policy.report(member.signPub, "connected");
      this.#register(member.signPub, link);
      return { ok: true, link };
    } catch (error) {
      const code = error instanceof Error ? closeCodeOf(error) : undefined;
      policy.report(member.signPub, code === 4429 ? 4429 : 4404);
      return {
        ok: false,
        code: code ?? 4404,
        reason: `${member.name}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  closeRevoked(view: MeshView): void {
    const current = new Set(view.members.map((member) => member.signPub));
    const capped = new Set(view.overCap.map((member) => member.signPub));
    for (const [key, links] of this.#open) {
      if (current.has(key)) continue;
      const reason = capped.has(key) ? "past the mesh's 12-member cap" : "revoked from the mesh";
      for (const link of links) link.close(4401, reason);
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
