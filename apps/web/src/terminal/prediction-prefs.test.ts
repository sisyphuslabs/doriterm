import { afterEach, describe, expect, test } from "bun:test";
import { loadPredictionPrefs, PREDICTION_KEY, PredictionPrefsStore } from "./prediction-prefs.ts";

const stored = (value: string | null): Pick<Storage, "getItem"> => ({
  getItem: (key) => (key === PREDICTION_KEY ? value : null),
});

function installLocalStorage(): Map<string, string> {
  const items = new Map<string, string>();
  const storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
  Reflect.set(globalThis, "localStorage", storage);
  return items;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("the Predict typing preference (Doriterm's own, not a Ghostty key)", () => {
  test("nothing stored reads as adaptive (When slow)", () => {
    expect(loadPredictionPrefs(stored(null))).toEqual({ mode: "adaptive" });
  });

  test("each stored mode reads back", () => {
    for (const mode of ["adaptive", "always", "never"] as const) {
      expect(loadPredictionPrefs(stored(JSON.stringify({ mode })))).toEqual({ mode });
    }
  });

  test("garbage reads as adaptive", () => {
    for (const value of ["{", "null", "7", '{"mode":"sometimes"}', '{"mode":1}', "[]"]) {
      expect(loadPredictionPrefs(stored(value))).toEqual({ mode: "adaptive" });
    }
  });

  test("an update is written to localStorage, read back by a new store, and tells its listeners", () => {
    const items = installLocalStorage();
    const store = new PredictionPrefsStore();
    expect(store.value).toEqual({ mode: "adaptive" });
    let told = 0;
    const unsubscribe = store.subscribe(() => {
      told += 1;
    });
    store.update({ mode: "never" });
    expect(store.value).toEqual({ mode: "never" });
    expect(items.get(PREDICTION_KEY)).toBe('{"mode":"never"}');
    expect(told).toBe(1);
    expect(new PredictionPrefsStore().value).toEqual({ mode: "never" });
    unsubscribe();
    store.update({ mode: "always" });
    expect(told).toBe(1);
  });

  test("a refused write still changes the value and tells the listeners", () => {
    const store = new PredictionPrefsStore();
    let told = 0;
    store.subscribe(() => {
      told += 1;
    });
    store.update({ mode: "always" });
    expect(store.value).toEqual({ mode: "always" });
    expect(told).toBe(1);
  });
});
