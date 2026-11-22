import type { MachineView } from "@doriface/protocol";

/**
 * How long a machine read connected may then read connecting or unreachable before the page shows it offline (#904).
 *
 * hc marks a machine unreachable on the first failed redial, within 50 ms of its line ending, and a healthy line ends
 * often: any relay blip ends every mesh line at once. The host then refuses new lines for its 10-20 s settle
 * (apps/host/src/mesh/dial-policy.ts, DIAL_LIMITS.settleMaxMs), and a member that was reconnecting too answers its
 * first dial with a 4404, which gates it until its first probe 30 s later (DIAL_LIMITS.probeFirstMs). hc's doubling
 * redial (0.25 s up to a 30 s cap) next tries 61.75 s after the drop, the slowest return measured on a real relay blip
 * (62 s). The page sees that return at its next machine.list read, up to MACHINE_REFRESH_MS (10 s) later, so 75 s
 * covers it with about 3 s to spare while the host's clock is not more than that behind this page's (a hold starts at
 * hc's `since_ms`, kept no earlier than the read before the drop, so a host clock further behind starts it early: with
 * it 9 s behind, that slowest return can read offline for up to 5 s). Otherwise a blip never reads offline, while a
 * machine that is really gone (a laptop asleep) reads offline 75 s after its line dropped. needs_login is an answer,
 * not a blip: it shows at once. Not covered, and read as offline: a 4404 met after hc's 31.75 s redial (the line lands
 * at 91.75 s), or a member still offline at its first probe (the second comes 60 s later); both mean the member itself
 * stayed away well past a blip.
 */
export const OFFLINE_GRACE_MS = 75_000;

/**
 * How long a drop may last before the page says why beside one way to try now (#2464): the host's own grace (#2448). The
 * host link and a machine line share it, so either drop offers its action at the same time; a machine line keeps its
 * longer OFFLINE_GRACE_MS before it reads offline, since a relay blip takes that long to come back by itself (#904).
 */
export const ACTION_GRACE_MS = 5_000;

const DOWN = new Set(["connecting", "unreachable"]);

/** Since when (this page's clock) each machine, by its permanent id, has read down while held as connected. */
export type Held = ReadonlyMap<string, number>;

/** The machine.list answer the page read before, and when (this page's clock); none before the first answer. */
export interface Before {
  readonly views: readonly MachineView[];
  readonly at: number | undefined;
  /** The page's first machine.list answer: when it was read and which machines it listed; none before it. */
  readonly first?: { readonly at: number; readonly ids: ReadonlySet<string> };
  /** Every machine (by id) any read so far found connected. */
  readonly up?: ReadonlySet<string>;
}

/**
 * The hold after one machine.list answer read at `now`. A machine held already keeps its start. A machine that reads
 * down is held from its drop when it read connected at the read before (dropped since then), or when this is the page's
 * first read and hc says when it dropped (a page opened mid-blip); a machine listed later for the first time (just
 * added, still dialing) was never connected, so it shows as hc says. The drop is hc's `since_ms`, which is the host's
 * clock, so it is kept between the read before (or one grace back, on a first read) and `now`: no host clock can
 * lengthen a hold, and a machine that went down while the page was hidden is not held for a drop that is older than its
 * grace. A machine that already read down at the read before is never held anew, so a grace that ended does not start
 * again. A machine the page's first read listed that no read has found connected since (it read connecting, and hc
 * names its drop only once it reads unreachable) is held from that drop, kept no earlier than one grace before the
 * first read and never later than `now`: a page opened mid-blip holds it for what is left of its grace, and since hc's
 * `since_ms` stays the drop time, that hold ends once and does not start again. Anything else (connected, needs_login,
 * down past the grace, gone from the list) is not held.
 */
export function stepHeld(held: Held, before: Before, list: readonly MachineView[], now: number): Map<string, number> {
  const seen = new Map(before.views.map((view) => [view.id, view.state]));
  const next = new Map<string, number>();
  for (const view of list) {
    if (!DOWN.has(view.state)) continue;
    const kept = held.get(view.id);
    const was = seen.get(view.id);
    const fresh = was === "connected" || (before.at === undefined && view.since_ms != null);
    const earliest = was === "connected" && before.at !== undefined ? before.at : now - OFFLINE_GRACE_MS;
    const opened =
      before.first !== undefined &&
      before.first.ids.has(view.id) &&
      before.up?.has(view.id) !== true &&
      view.since_ms != null &&
      view.since_ms <= now
        ? Math.max(view.since_ms, before.first.at - OFFLINE_GRACE_MS)
        : undefined;
    const since = kept ?? (fresh ? Math.min(now, Math.max(earliest, view.since_ms ?? now)) : opened);
    if (since !== undefined && now - since < OFFLINE_GRACE_MS) next.set(view.id, since);
  }
  return next;
}

/** The grace keeps existing terminals visible, but a down line is never advertised as ready to create. */
export function graceViews(list: readonly MachineView[], held: Held, now: number): readonly MachineView[] {
  if (held.size === 0) return list;
  return list.map((view) => {
    const since = held.get(view.id);
    if (since === undefined || now - since >= OFFLINE_GRACE_MS) return view;
    return { ...view, state: "reconnecting" };
  });
}

/** When the next held machine's grace ends (this page's clock), so the page can show it offline then; none if none. */
export function graceEnds(held: Held, now: number): number | undefined {
  const ends = [...held.values()].map((since) => since + OFFLINE_GRACE_MS).filter((end) => end > now);
  return ends.length === 0 ? undefined : Math.min(...ends);
}
