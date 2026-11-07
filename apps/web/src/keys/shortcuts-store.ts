import { useSyncExternalStore } from "react";

let shown = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (next === shown) return;
  shown = next;
  for (const listener of listeners) listener();
}

/** herdr-app's app.help: the chord that opens the shortcuts dialog closes it. */
export function toggleShortcuts(): void {
  set(!shown);
}

export function closeShortcuts(): void {
  set(false);
}

export function useShortcutsShown(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => shown,
  );
}
