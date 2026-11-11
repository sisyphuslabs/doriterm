import { describe, expect, test } from "bun:test";
import { activeThemeId, type Appearance, DEFAULT_APPEARANCE, parseAppearance } from "./stored.ts";

describe("parseAppearance", () => {
  test("a stored mode and picks come back as stored", () => {
    const stored: Appearance = {
      mode: "light",
      dark: "dracula",
      light: "solarized-light",
      density: "compact",
      custom: [],
    };
    expect(parseAppearance(stored)).toEqual(stored);
  });

  test.each([
    [{ theme: "system" }, { mode: "system", dark: "night", light: "day" }],
    [{ theme: "graphite" }, { mode: "dark", dark: "graphite", light: "day" }],
    [{ theme: "paper" }, { mode: "light", dark: "night", light: "paper" }],
    [{ theme: "gone" }, { mode: "dark", dark: "night", light: "day" }],
  ] as const)("the one-theme form %j becomes a mode and a pick", (stored, expected) => {
    expect(parseAppearance({ ...stored, custom: [] })).toEqual({ ...expected, density: "comfortable", custom: [] });
  });

  test("a pick of the wrong kind or an unknown id falls back to the default for that kind", () => {
    expect(parseAppearance({ mode: "dark", dark: "day", light: "nope", custom: [] })).toEqual({
      ...DEFAULT_APPEARANCE,
      mode: "dark",
    });
  });

  test.each(["compact", "comfortable", "spacious"] as const)("density %s is kept", (density) => {
    expect(parseAppearance({ density, custom: [] }).density).toBe(density);
  });

  test("an unknown density is comfortable", () => {
    expect(parseAppearance({ density: "tight", custom: [] }).density).toBe("comfortable");
  });

  test("anything that is not an object is the default", () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance("night")).toEqual(DEFAULT_APPEARANCE);
  });

  test("a fresh profile opens in the dark Night theme, even on a light device (#1403)", () => {
    expect(DEFAULT_APPEARANCE.mode).toBe("dark");
    expect(DEFAULT_APPEARANCE.dark).toBe("night");
    // The default is a setting value, not a rule: a light device does not move it, and Light stays one pick away.
    expect(activeThemeId(DEFAULT_APPEARANCE, false)).toBe("night");
    expect(activeThemeId({ ...DEFAULT_APPEARANCE, mode: "light" }, true)).toBe("day");
  });
});

describe("activeThemeId", () => {
  const appearance = { ...DEFAULT_APPEARANCE, dark: "nord", light: "tomorrow" };
  test.each([
    ["system", true, "nord"],
    ["system", false, "tomorrow"],
    ["dark", false, "nord"],
    ["light", true, "tomorrow"],
  ] as const)("%s with the system dark=%p shows %s", (mode, systemDark, id) => {
    expect(activeThemeId({ ...appearance, mode }, systemDark)).toBe(id);
  });
});
