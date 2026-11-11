import { useSyncExternalStore } from "react";
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

export function usePredictionMode(): DisplayMode {
  return useSyncExternalStore(predictionModeStore.subscribe, () => predictionModeStore.value);
}
