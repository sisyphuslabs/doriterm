import { useSyncExternalStore } from "react";
import type { ConnectionPath } from "../connection/connect.ts";
import { guardedLocalStorage } from "../storage/guarded.ts";
import type { DisplayMode } from "./prediction-display.ts";

const KEY = "doriface.terminal.predict-typing";
const MODES: readonly DisplayMode[] = ["adaptive", "always", "never"];

/**
 * Whether typed characters are drawn before the host echoes them (docs/design/remote-input-feel.md D8): `adaptive`
 * unless this device stored another choice. A Doriterm setting of this device, not a Ghostty key (#1439).
 */
function storedMode(): DisplayMode {
  const stored = guardedLocalStorage().getItem(KEY);
  return MODES.find((mode) => mode === stored) ?? "adaptive";
}

class PredictionModeStore {
  #value = storedMode();
  readonly #listeners = new Set<() => void>();
  get value(): DisplayMode {
    return this.#value;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  set(value: DisplayMode): void {
    this.#value = value;
    guardedLocalStorage().setItem(KEY, value);
    for (const listener of this.#listeners) listener();
  }
}

export const predictionModeStore = new PredictionModeStore();

/**
 * The mode a view predicts in: the desktop app's own host over loopback answers in a frame, so nothing is predicted there
 * unless this device chose `always`; relay and direct links keep the chosen mode (#1439).
 */
export function effectivePredictionMode(
  chosen: DisplayMode,
  path: ConnectionPath | undefined,
  desktop: boolean,
): DisplayMode {
  return desktop && path === "loopback" && chosen !== "always" ? "never" : chosen;
}

export function usePredictionMode(): DisplayMode {
  return useSyncExternalStore(predictionModeStore.subscribe, () => predictionModeStore.value);
}
