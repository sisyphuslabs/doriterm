import { describe, expect, test } from "bun:test";
import { activePaletteKey, activeThemeId, type Appearance, DEFAULT_APPEARANCE, parseAppearance } from "./stored.ts";

describe("parseAppearance", () => {
  test("a stored mode and picks come back as stored", () => {
    const stored: Appearance = {
      mode: "light",
      dark: "dracula",
      light: "solarized-light",
      density: "compact",
      showWordmark: false,
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
    expect(parseAppearance({ ...stored, custom: [] })).toEqual({
      ...expected,
      density: "comfortable",
      showWordmark: true,
      custom: [],
    });
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

  test("showWordmark defaults to true and only explicit false hides it (#2967)", () => {
    expect(DEFAULT_APPEARANCE.showWordmark).toBe(true);
    expect(
      parseAppearance({ mode: "dark", dark: "night", light: "day", density: "comfortable", custom: [] }).showWordmark,
    ).toBe(true);
    expect(parseAppearance({ showWordmark: true }).showWordmark).toBe(true);
    expect(parseAppearance({ showWordmark: false }).showWordmark).toBe(false);
    for (const invalid of ["false", 0, null, "", {}]) {
      expect(parseAppearance({ showWordmark: invalid }).showWordmark).toBe(true);
    }
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

function customThemeFile(background: string, red: string) {
  return {
    background,
    foreground: "#e8e6df",
    selection: "#334455",
    cursor: "#ffffff",
    ansi: [
      "#111111",
      red,
      "#22aa44",
      "#ccaa22",
      "#3366cc",
      "#aa44cc",
      "#22aaaa",
      "#cccccc",
      "#555555",
      "#ff5566",
      "#44cc66",
      "#eecc44",
      "#5588ee",
      "#cc66ee",
      "#44cccc",
      "#ffffff",
    ],
  };
}

describe("activePaletteKey", () => {
  test("changes on same-kind theme switch and ignores density or inactive-kind edits", () => {
    const base: Appearance = { ...DEFAULT_APPEARANCE, mode: "dark", dark: "night", light: "day" };
    const key = activePaletteKey(base, true);
    expect(activePaletteKey({ ...base, density: "compact" }, true)).toBe(key);
    expect(activePaletteKey({ ...base, light: "paper" }, true)).toBe(key);
    expect(activePaletteKey({ ...base, mode: "system", light: "paper" }, true)).toBe(key);
    expect(activePaletteKey({ ...base, dark: "dracula" }, true)).not.toBe(key);
    expect(activePaletteKey({ ...base, mode: "light" }, true)).not.toBe(key);
  });

  test("changes when the active custom theme's terminal colours change under the same id", () => {
    const first = { id: "custom:mine", name: "mine", file: customThemeFile("#101820", "#dd3344") };
    const updated = { id: "custom:mine", name: "mine", file: customThemeFile("#181020", "#ee7722") };
    const other = { id: "custom:other", name: "other", file: customThemeFile("#202020", "#cc2222") };
    const base: Appearance = { ...DEFAULT_APPEARANCE, mode: "dark", dark: first.id, custom: [first] };
    const key = activePaletteKey(base, true);

    expect(activePaletteKey({ ...base, density: "spacious" }, true)).toBe(key);
    expect(activePaletteKey({ ...base, custom: [first, other] }, true)).toBe(key);
    expect(activePaletteKey({ ...base, custom: [updated] }, true)).not.toBe(key);
  });

  test("ignores an unparseable custom entry", () => {
    const broken = { id: "night", name: "night", file: { background: "not-a-hex" } };
    const base: Appearance = { ...DEFAULT_APPEARANCE, mode: "dark", dark: "night", custom: [broken] };
    expect(activePaletteKey(base, true)).toBe("night");
  });
});
