import { describe, expect, test } from "bun:test";
import { guessedSpace, afterIn, placedFate } from "./placement.ts";

describe("guessedSpace: the guess before a placed tab's write (#2481 review)", () => {
  test("a space the write would make is guessed with the empty id, so it never matches a space the write makes", () => {
    let asked = 0;
    const made = guessedSpace((_doc, makeId) => {
      asked += 1;
      return { id: makeId("spc"), folder: "", name: "Work" };
    }, null);
    expect(made).toEqual({ id: "", folder: "", name: "Work" });
    expect(asked).toBe(1);
  });

  test("an existing space is guessed by its own id", () => {
    expect(guessedSpace(() => ({ id: "spc1", folder: "/w" }), null)).toEqual({ id: "spc1", folder: "/w" });
  });

  test("a tab nothing places is not guessed", () => {
    expect(guessedSpace(undefined, null)).toBeUndefined();
  });
});

describe("a tab placed by its terminal's labels (#2468)", () => {
  test("never takes the transient tab with it: that one keeps a space of its own", () => {
    expect(placedFate("with-new", true)).toBe("apart");
    expect(placedFate("apart", true)).toBe("apart");
    expect(placedFate(null, true)).toBeNull();
  });

  test("a tab not placed by labels keeps whatever the transient tab's own rule says", () => {
    expect(placedFate("with-new", false)).toBe("with-new");
    expect(placedFate("apart", false)).toBe("apart");
    expect(placedFate(null, false)).toBeNull();
  });

  test("goes after the tab in view only in the space guessed before the write", () => {
    expect(afterIn("spc-lanes", "spc-lanes", "tb-view")).toBe("tb-view");
    // Another client made the space meanwhile, or the write made it: the tab goes at that space's end.
    expect(afterIn("spc-elsewhere", "spc-lanes", "tb-view")).toBeUndefined();
    expect(afterIn("spc-new", "", "tb-view")).toBeUndefined();
  });
});
