import { useSyncExternalStore } from "react";
import type { DisplayMode } from "./prediction-display.ts";
import { guardedLocalStorage } from "../storage/guarded.ts";

/** Predict typing: When slow (`adaptive`), Always or Never. Doriterm's own preference, not a Ghostty key (#1439). */
export type PredictionMode = DisplayMode;

export interface PredictionPrefs {
  readonly mode: PredictionMode;
}

export const PREDICTION_KEY = "doriface.prediction";
const DEFAULT: PredictionPrefs = { mode: "adaptive" };

const isMode = (value: unknown): value is PredictionMode =>
  value === "adaptive" || value === "always" || value === "never";

export function loadPredictionPrefs(storage: Pick<Storage, "getItem"> = guardedLocalStorage()): PredictionPrefs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(PREDICTION_KEY) ?? "null");
  } catch {
    return DEFAULT;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT;
  const mode: unknown = Reflect.get(parsed, "mode");
  return isMode(mode) ? { mode } : DEFAULT;
}

export class PredictionPrefsStore {
  #value = loadPredictionPrefs();
  #listeners = new Set<() => void>();
  get value(): PredictionPrefs {
    return this.#value;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  update(patch: Partial<PredictionPrefs>): void {
    this.#value = { ...this.#value, ...patch };
    try {
      guardedLocalStorage().setItem(PREDICTION_KEY, JSON.stringify(this.#value));
    } finally {
      for (const listener of this.#listeners) listener();
    }
  }
}

export const predictionPrefs = new PredictionPrefsStore();

export function usePredictionMode(): readonly [PredictionMode, (mode: PredictionMode) => void] {
  const mode = useSyncExternalStore(predictionPrefs.subscribe, () => predictionPrefs.value.mode);
  return [mode, (next) => predictionPrefs.update({ mode: next })];
}
