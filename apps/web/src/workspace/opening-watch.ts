import type { Terminal } from "@doriface/protocol";

/** What the feed showed of a terminal this page is starting, between the run and its answer. */
export interface OpeningSeen {
  /** The feed listed it live: it ran, and a tab may have shown it alone. */
  live: boolean;
  /** An End of it from this page was in flight. */
  ended: boolean;
}

type Listed = Pick<Terminal, "address" | "name" | "state">;

/**
 * Notes, for each start not settled yet (by the name it gives its terminal), what the feed shows of its terminal now:
 * listed live, and whether this page is ending it. Read on every feed change, so an End that settles before the run
 * answers is still known when it does.
 */
export function watchOpenings(
  inFlight: ReadonlyMap<string, OpeningSeen>,
  terminals: readonly Listed[],
  ending: (address: string) => boolean,
): void {
  for (const [name, seen] of inFlight) {
    const found = terminals.find((terminal) => terminal.name === name);
    if (found === undefined) continue;
    if (found.state === "live") seen.live = true;
    if (ending(found.address)) seen.ended = true;
  }
}

/**
 * Whether the run's answer places the terminal at `address` in a tab (#2913): not once this page ended it (an End in
 * flight, or one seen while the run was out), nor once the feed, having listed it live, lists it no longer live or not
 * at all (closed, or ended on another device), since its tab would wait for a terminal that is gone. A terminal never
 * seen live is placed: the answer came first, or it ended at launch and its tab shows how (just-born).
 */
export function placeable(
  seen: OpeningSeen,
  terminals: readonly Listed[],
  address: string,
  ending: (address: string) => boolean,
): boolean {
  if (seen.ended || ending(address)) return false;
  return !seen.live || terminals.some((terminal) => terminal.address === address && terminal.state === "live");
}
