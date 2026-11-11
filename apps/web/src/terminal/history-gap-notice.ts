import { useSyncExternalStore } from "react";

/**
 * Whether a reconnect may have lost output from the history of a terminal on screen, until the person dismisses the
 * notice. hc's attach has no cursor to resume from (#2033, herdrdev/herdr-core#233), so a reattach to a view the core
 * painted repaints the screen alone (#1997): what scrolled off the core's screen while the line was down never reaches
 * the history. The notice is said outside the terminal, beside the connection status; nothing is drawn over the output.
 */
let noted = false;
const listeners = new Set<() => void>();

const publish = (next: boolean): void => {
  if (next === noted) return;
  noted = next;
  for (const listener of listeners) listener();
};

export const noteHistoryGap = (): void => publish(true);

export const dismissHistoryGap = (): void => publish(false);

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useHistoryGapNoted = (): boolean => useSyncExternalStore(subscribe, () => noted);
