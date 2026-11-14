import { describe, expect, test } from "bun:test";
import type { StorageLike } from "../storage/guarded.ts";
import { keepsPlace, loadPhonePlace, PHONE_PLACE_KEY, placeStart, savePhonePlace } from "./phone-place.ts";
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
    savePhonePlace(place, "", storage);
    expect(loadPhonePlace("", storage)).toEqual({ ...place, sheet: false });
  });

  test("nothing kept, junk, or a value of the wrong shape is the agents list", () => {
    expect(loadPhonePlace("", memory())).toEqual(PHONE_LIST);
    expect(loadPhonePlace("", memory({ [PHONE_PLACE_KEY]: "{not json" }))).toEqual(PHONE_LIST);
    expect(loadPhonePlace("", memory({ [PHONE_PLACE_KEY]: "7" }))).toEqual(PHONE_LIST);
    expect(loadPhonePlace("", memory({ [PHONE_PLACE_KEY]: JSON.stringify({ v: 1, s: "", t: ["x"] }) }))).toEqual(
      PHONE_LIST,
    );
  });

  test("a cold start waits for an app's launch tap before it restores, and a tapped notice then wins", () => {
    const cold = {
      atBareList: true,
      landedHere: true,
      noticePending: false,
      launchPending: false,
      remembered: "/?v=spaces",
    };
    expect(placeStart(cold)).toBe("restore");
    // An app asks for the tap that launched it asynchronously: until it answers, nothing is decided.
    expect(placeStart({ ...cold, launchPending: true })).toBe("wait");
    // It answered with a notice: the notice opens its pane, with nothing of the remembered place under it.
    expect(placeStart({ ...cold, noticePending: true })).toBe("stay");
    // An address that names a place, a page that has moved, or nothing remembered: the phone stays where it is.
    expect(placeStart({ ...cold, atBareList: false, launchPending: true })).toBe("stay");
    expect(placeStart({ ...cold, landedHere: false })).toBe("stay");
    expect(placeStart({ ...cold, remembered: "/" })).toBe("stay");
  });

  test("while a restore is on its way only the bare list is held back from saving; any other place is kept", () => {
    expect(keepsPlace("/", true)).toBe(false);
    expect(keepsPlace("/?v=spaces", true)).toBe(true);
    // A notice that opened over the restore lands elsewhere: saving goes on from there instead of stalling.
    expect(keepsPlace("/?t=local%2Ftb-9", true)).toBe(true);
    expect(keepsPlace("/", false)).toBe(true);
  });

  test("the bare agents list is kept as one, so a later cold start opens on it", () => {
    const storage = memory();
    savePhonePlace({ section: "agents", space: "s1", terminal: null, sheet: false }, "", storage);
    savePhonePlace(PHONE_LIST, "", storage);
    expect(loadPhonePlace("", storage)).toEqual(PHONE_LIST);
  });
});

describe("the phone's place across a route change (#2537)", () => {
  test("a place kept going through one host is the same space and terminal going through another", () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, s: string) => void saved.set(k, s),
      removeItem: (k: string) => void saved.delete(k),
    };
    savePhonePlace({ section: "spaces", space: "space:s1", terminal: "local:t7", sheet: false }, "c", storage);
    expect(loadPhonePlace("m", storage)).toEqual({
      section: "spaces",
      space: "space:c/s1",
      terminal: "id:c/t7",
      sheet: false,
    });
    expect(loadPhonePlace("c", storage)).toEqual({
      section: "spaces",
      space: "space:s1",
      terminal: "local:t7",
      sheet: false,
    });
  });
});
