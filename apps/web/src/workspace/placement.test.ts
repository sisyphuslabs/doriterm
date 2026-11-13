import { describe, expect, test } from "bun:test";
import { afterIn, placedFate } from "./placement.ts";

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
