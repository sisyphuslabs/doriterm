import { describe, expect, test } from "bun:test";
import { widthTier } from "./width-tier.ts";

// CSS px. Foldables from their makers' specs: Galaxy Z Fold7 cover 1080 x 2520 and inner 1968 x 2184 at DPR 2.625;
// iPhone Duo outer 1398 x 2034 and inner 1878 x 2670 at 3x.
const desktopAt = (width: number) => widthTier({ width, screen: { width: 1440, height: 900 }, coarse: false });

describe("the three width tiers (design proposal section 4)", () => {
  test.each([
    ["a phone in portrait", 390, 844, true, "compact"],
    ["a phone in landscape keeps the phone shell", 844, 390, true, "compact"],
    ["iPhone SE in landscape", 667, 375, true, "compact"],
    ["Galaxy Z Fold7 folded (cover)", 412, 960, true, "compact"],
    ["Galaxy Z Fold7 unfolded", 750, 832, true, "medium"],
    ["Galaxy Z Fold7 unfolded, landscape", 832, 750, true, "medium"],
    ["iPhone Duo closed (outer display)", 466, 678, true, "compact"],
    ["iPhone Duo closed, landscape", 678, 466, true, "compact"],
    ["iPhone Duo open (inner display)", 626, 890, true, "medium"],
    ["iPhone Duo open, landscape", 890, 626, true, "medium"],
    ["iPad 1/3 Split View", 320, 1194, true, "compact"],
    ["iPad 1/2 Split View", 597, 834, true, "compact"],
    ["iPad mini portrait", 744, 1133, true, "medium"],
    ["iPad portrait", 834, 1194, true, "medium"],
    ["iPad portrait at 768", 768, 1024, true, "medium"],
    ["iPad landscape", 1194, 834, true, "wide"],
    ["a 1024 window", 1024, 768, false, "wide"],
    ["a desktop window", 1440, 900, false, "wide"],
    ["a narrow mouse window", 700, 400, false, "medium"],
    ["a very narrow mouse window", 500, 800, false, "compact"],
  ] as const)("%s (%d x %d) is %s", (_name, width, height, touch, tier) => {
    expect(widthTier({ width, screen: { width, height }, coarse: touch })).toBe(tier);
  });

  test("a touch screen's short side, not the window, decides a phone: a phone window wider than 600 stays compact", () => {
    expect(widthTier({ width: 844, screen: { width: 390, height: 844 }, coarse: true })).toBe("compact");
    expect(widthTier({ width: 844, screen: { width: 390, height: 844 }, coarse: false })).toBe("medium");
  });

  test("the edges: 600 is medium, 1024 is wide", () => {
    expect([desktopAt(599), desktopAt(600), desktopAt(1023), desktopAt(1024)]).toEqual([
      "compact",
      "medium",
      "medium",
      "wide",
    ]);
  });
});
