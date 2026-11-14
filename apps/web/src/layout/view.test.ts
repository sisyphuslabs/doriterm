import { describe, expect, test } from "bun:test";
import { seenOn, storedSeen } from "./view-keys.ts";
import { loadView, NO_VIEW, rememberSeen, saveView, type View, VIEW_KEY } from "./view.ts";

/** A storage holding one raw value as the device's view, as a page would have left it. */
const holding = (raw: string | null): Pick<Storage, "getItem"> => ({
  getItem: (key) => (key === VIEW_KEY ? raw : null),
});
const loaded = (value: unknown): View => loadView("c", holding(JSON.stringify(value)), []);

describe("loadView", () => {
  test("reads the active tab, the focused and zoomed panes, each space's tab and the finishes it has seen", () => {
    const view: View = {
      active: "t2",
      focused: { t1: "p1", t2: "p4" },
      zoomed: { t2: "p4" },
      spaces: { "space:s1": "t2", "space:m/s2": "m/t1" },
      seen: { t1: "41", "m/t2": "77" },
    };
    const saved = new Map<string, string>();
    expect(saveView("c", view, { setItem: (key, value) => saved.set(key, value) })).toBeNull();
    expect(loadView("c", { getItem: (key) => saved.get(key) ?? null })).toEqual(view);
  });

  test("an older screen's strip order is not read: the tabs' order is the documents' own (#404)", () => {
    expect(loaded({ active: "a", focused: { a: "p1" }, order: ["b", "a"] })).toEqual({
      active: "a",
      focused: { a: "p1" },
      zoomed: {},
      spaces: {},
      seen: {},
    });
  });

  test("a screen saved before finishes were noted keeps none, and today's read back as saved (#611)", () => {
    expect(loaded({ active: "a", seen: undefined }).seen).toEqual({});
    expect(loaded({ seen: { t1: "41", "m/t2": "77" } }).seen).toEqual({ t1: "41", "m/t2": "77" });
  });

  test("fields of the wrong kind read as unset, one by one", () => {
    expect(
      loaded({ active: 4, focused: { a: 1, b: "p2" }, zoomed: ["p1"], spaces: { s: "a", t: 2 }, seen: { a: 41 } }),
    ).toEqual({
      active: null,
      focused: { b: "p2" },
      zoomed: {},
      spaces: { s: "a" },
      seen: {},
    });
  });

  test("nothing saved, unreadable JSON or a value that is not an object reads as no view", () => {
    expect(loadView("c", holding(null))).toEqual(NO_VIEW);
    expect(loadView("c", holding("{not json"))).toEqual(NO_VIEW);
    expect(loaded(["a"])).toEqual(NO_VIEW);
    expect(loaded("a")).toEqual(NO_VIEW);
  });
});

const memory = () => {
  const saved = new Map<string, string>();
  return {
    saved,
    storage: { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, s: string) => void saved.set(k, s) },
  };
};

describe("one view per device, whichever host the page goes through (#2537)", () => {
  // Through core c, its tab tb-1 is bare and machine m's tb-2 is keyed by m's id; seen marks stay by machine id.
  const view: View = {
    active: "tb-1",
    focused: { "tb-1": "p1", "m/tb-2": "p2" },
    zoomed: {},
    spaces: { "space:s1": "tb-1", "space:m/s2": "m/tb-2" },
    seen: { "@c/t1": "41", "@m/t2": "77" },
  };
  // What each core calls the other: c lists m as "box", m lists c as "studio".
  const viaC = { byName: new Map([["box", "m"]]), byId: new Map([["m", "box"]]) };
  const viaM = { byName: new Map([["studio", "c"]]), byId: new Map([["c", "studio"]]) };

  test("saved going through core c and read going through core m, every tab, space, focus and seen mark is the same one", () => {
    const { storage } = memory();
    expect(saveView("c", view, storage)).toBeNull();
    const there = loadView("m", storage, []);
    expect(there).toEqual({
      active: "c/tb-1",
      focused: { "c/tb-1": "p1", "tb-2": "p2" },
      zoomed: {},
      spaces: { "space:c/s1": "c/tb-1", "space:s2": "tb-2" },
      seen: view.seen,
    });
    expect(seenOn(there.seen, "m", viaM)).toEqual({ "studio/t1": "41", t2: "77" });
    expect(loadView("c", storage, [])).toEqual(view);
    expect(seenOn(view.seen, "c", viaC)).toEqual({ t1: "41", "box/t2": "77" });
  });

  test("a mark made through one core is the same mark through the other", () => {
    const kept = storedSeen({ t1: "41", "box/t2": "77" }, "c", viaC);
    expect(kept).toEqual({ "@c/t1": "41", "@m/t2": "77" });
    expect(storedSeen(seenOn(kept, "m", viaM), "m", viaM)).toEqual(kept);
  });

  test("a device with only per-host views saved before starts from all of them, the current host's winning", () => {
    const c = {
      active: "tb-1",
      focused: { "tb-1": "p1" },
      zoomed: {},
      spaces: { "space:s1": "tb-1" },
      seen: { t1: "41" },
    };
    const m = {
      active: "tb-9",
      focused: { "tb-9": "p9" },
      zoomed: {},
      spaces: { "space:s9": "tb-9" },
      seen: { t9: "5" },
    };
    const old = {
      getItem: (key: string) =>
        key === "doriface.view.c" ? JSON.stringify(c) : key === "doriface.view.m" ? JSON.stringify(m) : null,
    };
    expect(loadView("c", old, ["c", "m"])).toEqual({
      active: "tb-1",
      focused: { "m/tb-9": "p9", "tb-1": "p1" },
      zoomed: {},
      spaces: { "space:m/s9": "m/tb-9", "space:s1": "tb-1" },
      seen: { "@m/t9": "5", "@c/t1": "41" },
    });
  });
});

describe("rememberSeen", () => {
  test("notes a finish this screen showed, keeps the rest of the view, and writes nothing twice (#611)", () => {
    const view: View = { ...NO_VIEW, active: "t2" };
    const once = rememberSeen(view, { t1: "3" });
    expect(once).toEqual({ ...NO_VIEW, active: "t2", seen: { t1: "3" } });
    expect(rememberSeen(once, { t1: "3" })).toBe(once);
    expect(rememberSeen(once, {}).seen).toEqual({ t1: "3" });
    // A later finish of the same terminal takes its place; another terminal is added beside it.
    expect(rememberSeen(once, { t1: "4", t2: "7" }).seen).toEqual({ t1: "4", t2: "7" });
  });
});

describe("saveView", () => {
  test("a storage that refuses the write (full or denied) says why, and saving does not throw", () => {
    const full: Pick<Storage, "setItem"> = {
      setItem: () => {
        throw new DOMException("the quota has been exceeded", "QuotaExceededError");
      },
    };
    expect(saveView("c", { ...NO_VIEW, active: "a" }, full)).toBe("the quota has been exceeded");
  });
});
