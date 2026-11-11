import { useEffect, useSyncExternalStore } from "react";

/**
 * Why a terminal's history may be missing output (#2033): `reconnect` when the connection dropped while its view was
 * painted, `stream` when the core ended the terminal's stream on a live connection and the view attached again.
 */
export type HistoryGapCause = "reconnect" | "stream";

/**
 * Which terminals' history may be missing output, by address, until the person dismisses the note. hc's attach has no
 * cursor to resume from (#2033, herdrdev/herdr-core#233), so a reattach to a view the core painted repaints the screen
 * alone (#1997): what scrolled off the core's screen meanwhile never reaches the history. The note is said outside the
 * terminal, for the terminal on screen (#2257); nothing is drawn over the output.
 */
const gaps = new Map<string, HistoryGapCause>();
const listeners = new Set<() => void>();

const changed = (): void => {
  for (const listener of listeners) listener();
};

/** Raises the note for a terminal; a reconnect, once raised, is not turned back into a lost stream. */
export function noteHistoryGap(address: string, cause: HistoryGapCause): void {
  const now = gaps.get(address);
  if (now === cause || now === "reconnect") return;
  gaps.set(address, cause);
  changed();
}

/** The person has read the note: it goes until the terminal loses output again. */
export function dismissHistoryGap(address: string): void {
  if (gaps.delete(address)) changed();
}

/** The view was attached anew, with its history played back: nothing it shows is missing any more. */
export const clearHistoryGap = dismissHistoryGap;

/**
 * Keeps the notes of the terminals the feed lists live (`live`, by address) and drops the rest: a terminal that ended or
 * was closed while noted takes its note with it, so an address used again later starts with none (#2292).
 */
export function keepHistoryGapsOf(live: ReadonlySet<string>): void {
  let dropped = false;
  for (const address of gaps.keys()) {
    if (live.has(address)) continue;
    gaps.delete(address);
    dropped = true;
  }
  if (dropped) changed();
}

export const historyGapFor = (address: string | null): HistoryGapCause | null =>
  address === null ? null : (gaps.get(address) ?? null);

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useHistoryGap = (address: string | null): HistoryGapCause | null =>
  useSyncExternalStore(subscribe, () => historyGapFor(address));

/** Drops the notes of the terminals the loaded feed no longer lists live: the workspace's hook for keepHistoryGapsOf. */
export function useForgetEndedHistoryGaps(
  loaded: boolean,
  terminals: readonly { readonly address: string; readonly state: string }[],
): void {
  useEffect(() => {
    if (loaded) keepHistoryGapsOf(new Set(terminals.flatMap((each) => (each.state === "live" ? [each.address] : []))));
  }, [loaded, terminals]);
}
