import { describe, expect, test } from "bun:test";
import type { StorageLike } from "../storage/guarded.ts";
import { loadPhonePlace, PHONE_PLACE_KEY, savePhonePlace } from "./phone-place.ts";
import { PHONE_LIST } from "./phone-route.ts";

function memory(initial: Record<string, string> = {}): StorageLike & { readonly items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

describe("the phone's remembered place", () => {
  test("a section, space and terminal round-trip, and the sheet is never kept", () => {
    const storage = memory();
    const place = { section: "spaces", space: "space:local/spc-web", terminal: "local/tb-1", sheet: true } as const;
    savePhonePlace(place, storage);
    expect(loadPhonePlace(storage)).toEqual({ ...place, sheet: false });
  });

  test("nothing kept, junk, or a value of the wrong shape is the agents list", () => {
    expect(loadPhonePlace(memory())).toEqual(PHONE_LIST);
    expect(loadPhonePlace(memory({ [PHONE_PLACE_KEY]: "{not json" }))).toEqual(PHONE_LIST);
    expect(loadPhonePlace(memory({ [PHONE_PLACE_KEY]: "7" }))).toEqual(PHONE_LIST);
    expect(loadPhonePlace(memory({ [PHONE_PLACE_KEY]: JSON.stringify({ v: 1, s: "", t: ["x"] }) }))).toEqual(
      PHONE_LIST,
    );
  });

  test("the bare agents list is kept as one, so a later cold start opens on it", () => {
    const storage = memory();
    savePhonePlace({ section: "agents", space: "s1", terminal: null, sheet: false }, storage);
    savePhonePlace(PHONE_LIST, storage);
    expect(loadPhonePlace(storage)).toEqual(PHONE_LIST);
  });
});
