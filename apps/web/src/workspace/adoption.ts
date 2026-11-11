import { END_LABEL, type JsonObject, type Terminal } from "@doriface/protocol";
import { panesOf, tabsOf } from "@doriface/protocol/layout";

/**
 * How long a terminal first seen in no tab waits before it is adopted, the time herdr-app gives a terminal that was
 * just started (`just_born`): whoever started it, this page or another device, writes its own tab meanwhile, and a
 * program that ends at once never gets one.
 */
export const ADOPT_GRACE_MS = 5_000;

/** Addresses by their numbers (`t9` before `t10`), for terminals started in the same millisecond. */
const BY_ADDRESS = new Intl.Collator("en", { numeric: true });

/** A terminal as its own machine's document names it: `t7` for `build-box/t7`. */
const local = (address: string): string => address.slice(address.indexOf("/") + 1);

/** The pane of a machine's document that shows the terminal (as that machine names it), with its tab. */
export function shownIn(
  doc: JsonObject | null,
  terminal: string,
): { readonly tab: string; readonly pane: string } | null {
  for (const tab of doc === null ? [] : tabsOf(doc)) {
    const pane = panesOf(tab.root).find((each) => each.terminal === terminal);
    if (pane !== undefined) return { tab: tab.id, pane: pane.id };
  }
  return null;
}

/**
 * The terminals of one machine that get a tab of their own and have none in its document (#404): live, started by no
 * other terminal (`parent`), and shown by no pane. One that End is ending is not among them (#2122): its tab was closed
 * on purpose and its program is on its way out, so adopting it would bring the closed tab back until the kill lands.
 * They come in the order they started, not the feed's: hc lists them by address as text, so `t10` came before `t9`
 * (#1269).
 */
export function looseTerminals(doc: JsonObject | null, terminals: readonly Terminal[]): Terminal[] {
  const shown = new Set(
    doc === null
      ? []
      : tabsOf(doc).flatMap((tab) =>
          panesOf(tab.root).flatMap((pane) => (pane.terminal === null ? [] : [pane.terminal])),
        ),
  );
  return terminals
    .filter(
      (terminal) =>
        terminal.state === "live" &&
        (terminal.parent ?? null) === null &&
        (terminal.labels[END_LABEL] ?? "") === "" &&
        !shown.has(local(terminal.address)),
    )
    .toSorted((a, b) => a.created_ms - b.created_ms || BY_ADDRESS.compare(a.address, b.address));
}

/** What one machine's adoption remembers from one look to the next. */
export interface Look {
  /** When each terminal still in no tab was first seen there, in ms since the epoch. */
  readonly since: ReadonlyMap<string, number>;
  /** The terminals an adoption was written for that are still in no tab: not written again while they stay there. */
  readonly tried: ReadonlySet<string>;
}

export interface AdoptionStep {
  readonly look: Look;
  readonly adopt: readonly string[];
  /** When the earliest terminal still waiting is due, in ms since the epoch; none when nothing waits. */
  readonly wake: number | undefined;
}

/**
 * One look at the terminals of a machine that are in no tab (`loose`, by address), as herdr-app's `reconcile` looks on
 * every listing: which to adopt now, and when to look again. The machine's first look (`before` undefined) adopts them
 * all, as a page load always did. After that a terminal waits ADOPT_GRACE_MS from when it was first seen in no tab. One
 * an adoption was written for is not written again while it stays there: that write is in flight, or it was refused
 * and said so once.
 */
export function stepAdoption(before: Look | undefined, loose: readonly string[], now: number): AdoptionStep {
  const firstSeen = before === undefined ? now - ADOPT_GRACE_MS : now;
  const since = new Map(loose.map((address) => [address, before?.since.get(address) ?? firstSeen]));
  const dueAt = (address: string): number => (since.get(address) ?? now) + ADOPT_GRACE_MS;
  const written = loose.filter((address) => before?.tried.has(address) === true);
  const unwritten = loose.filter((address) => !written.includes(address));
  const adopt = unwritten.filter((address) => dueAt(address) <= now);
  const waiting = unwritten.filter((address) => dueAt(address) > now);
  return {
    look: { since, tried: new Set([...written, ...adopt]) },
    adopt,
    wake: waiting.length === 0 ? undefined : Math.min(...waiting.map(dueAt)),
  };
}
