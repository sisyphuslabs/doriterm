import { useSyncExternalStore } from "react";

/** What a pinch in progress would give a terminal: its size and the grid that size fits. */
export interface PinchReadout {
  readonly size: number;
  readonly cols: number;
  readonly rows: number;
}

const readouts = new Map<string, PinchReadout>();
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) listener();
};

/** Set while a pinch moves on `address`, cleared when it ends: the header shows it, nothing is drawn over the terminal. */
export function showPinchReadout(address: string, readout: PinchReadout | null): void {
  if (readout === null) {
    if (readouts.delete(address)) notify();
    return;
  }
  readouts.set(address, readout);
  notify();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function usePinchReadout(address: string): PinchReadout | null {
  return useSyncExternalStore(subscribe, () => readouts.get(address) ?? null);
}

/** The header's words for a readout: "11 pt · 58 × 40 on this phone". */
export const readoutText = ({ size, cols, rows }: PinchReadout): string =>
  `${size} pt · ${cols} × ${rows} on this phone`;
