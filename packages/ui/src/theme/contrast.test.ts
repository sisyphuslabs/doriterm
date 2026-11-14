import { describe, expect, test } from "bun:test";
import { BUILTIN_PALETTES } from "./builtins.ts";
import { contrast, mix, parseRgba, type Rgb } from "./color.ts";
import { DISABLED_STEP, disabledGlyph, themeVariables } from "./css.ts";
import { AA_GRAPHIC, AA_TEXT, flatten, worstContrast } from "./guard.ts";
import { resolveTheme } from "./resolve.ts";

/**
 * Whether a disabled glyph can be the full DISABLED_STEP from `muted` and still hold 3:1 on `surface`, on the path the
 * disabled ink is picked from: `muted` moved toward the surface in 1% steps (css.ts). `contrast(muted, surface) >= 5.1`
 * is the same question for a continuous path, and a palette just above it can have no 1% stop that holds both (#1896).
 */
function stepReachable(muted: Rgb, surface: Rgb): boolean {
  for (let step = 1; step <= 100; step += 1) {
    const candidate = mix(muted, surface, step / 100);
    if (contrast(candidate, surface) < AA_GRAPHIC) return false;
    if (contrast(candidate, muted) >= DISABLED_STEP) return true;
  }
  return false;
}

/** The disabled glyph's two requirements: always 3:1 on its surface, and the full step wherever the path reaches it. */
function expectDisabledGlyph(disabled: Rgb, muted: Rgb, surface: Rgb): void {
  expect(contrast(disabled, surface)).toBeGreaterThanOrEqual(AA_GRAPHIC);
  if (stepReachable(muted, surface)) expect(contrast(disabled, muted)).toBeGreaterThanOrEqual(DISABLED_STEP);
}

test("a muted glyph just above 5.1:1 whose 1% path holds no stop with both keeps the 3:1 floor (#1896)", () => {
  const muted = 0x7e7e7e;
  const surface = 0x000000;
  expect(contrast(muted, surface)).toBeGreaterThanOrEqual(AA_GRAPHIC * DISABLED_STEP);
  expect(stepReachable(muted, surface)).toBe(false);
  const disabled = parseRgba(disabledGlyph(muted, surface))?.rgb;
  if (disabled === undefined) throw new Error("no disabled glyph");
  expectDisabledGlyph(disabled, muted, surface);
});

test("contrast follows WCAG 2.2", () => {
  expect(contrast(0x000000, 0xffffff)).toBeCloseTo(21, 5);
  expect(contrast(0x777777, 0xffffff)).toBeCloseTo(4.48, 2);
});

describe.each(Object.entries(BUILTIN_PALETTES))("%s meets WCAG 2.2 AA", (_, palette) => {
  const theme = resolveTheme(palette);
  const vars = themeVariables(theme);
  const role = (name: string): string => {
    const value = vars[name];
    if (value === undefined) throw new Error(`missing --${name}`);
    return value;
  };
  const base = parseRgba(theme.roles.background)?.rgb ?? 0;
  const opaque = ["canvas", "surface", "chrome", "popover", "raised"].map((name) => flatten(role(name), base));
  const [canvasRgb, surfaceRgb, chromeRgb, popoverRgb] = opaque;
  if (canvasRgb === undefined || surfaceRgb === undefined || chromeRgb === undefined || popoverRgb === undefined)
    throw new Error("missing surface");
  const underSelected = [surfaceRgb, canvasRgb, chromeRgb, popoverRgb];
  const surfaces = [...opaque, ...underSelected.map((under) => flatten(role("selected"), under))];

  test.each(["foreground", "muted-foreground", "brand", "destructive"])("--%s text on every surface", (name) => {
    expect(worstContrast(role(name), surfaces)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  test.each(["input", "ring", "status-working", "status-blocked", "status-done", "status-idle"])(
    "--%s edge or glyph on every surface",
    (name) => {
      expect(worstContrast(role(name), surfaces)).toBeGreaterThanOrEqual(AA_GRAPHIC);
    },
  );

  test("--disabled-glyph holds 3:1 on its raised stepper and steps 1.7 from --muted-foreground where that leaves room", () => {
    const raised = opaque[4];
    const muted = parseRgba(role("muted-foreground"))?.rgb;
    const disabled = parseRgba(role("disabled-glyph"))?.rgb;
    if (raised === undefined || muted === undefined || disabled === undefined) throw new Error("missing role");
    expectDisabledGlyph(disabled, muted, raised);
  });

  test("--disabled-ink holds 4.5:1 on every surface a label with no fill sits on (#2510)", () => {
    expect(worstContrast(role("disabled-ink"), opaque)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  test("--muted-foreground holds 4.5:1 on the hover wash, where a highlighted disabled menu item draws it (#2513 review)", () => {
    const washed = [canvasRgb, surfaceRgb, chromeRgb, popoverRgb].map((under) => flatten(role("hover"), under));
    expect(worstContrast(role("muted-foreground"), washed)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  test("primary button label", () => {
    expect(worstContrast(role("primary-foreground"), [flatten(role("primary"), base)])).toBeGreaterThanOrEqual(AA_TEXT);
  });

  test.each(["working", "blocked", "done", "idle"])("%s chip label on its own tint", (status) => {
    const chips = surfaces.map((surface) => flatten(`${role(`status-${status}`)}26`, surface));
    expect(worstContrast(role(`status-${status}-text`), chips)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  test.each(["term-fg", "term-faint"])("--%s terminal text", (name) => {
    expect(worstContrast(role(name), [flatten(role("term-bg"), base)])).toBeGreaterThanOrEqual(AA_TEXT);
  });
});
