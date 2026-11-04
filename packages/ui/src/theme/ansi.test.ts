import { expect, test } from "bun:test";
import { ansiTextContrast } from "./ansi.ts";
import { BUILTIN_PALETTES, CORE_PALETTES } from "./builtins.ts";
import { AA_GRAPHIC } from "./guard.ts";
import { resolveTheme } from "./resolve.ts";

test.each(Object.entries(CORE_PALETTES))("%s keeps every ANSI text colour at 4.5:1", (_, palette) => {
  expect(ansiTextContrast(resolveTheme(palette))).toBeGreaterThanOrEqual(4.5);
});

test("Everforest Light ships yellow at 1.76:1, the lowest of the library", () => {
  expect(ansiTextContrast(resolveTheme(BUILTIN_PALETTES["everforest-light"]))).toBeCloseTo(1.76, 2);
});

test("an ANSI colour equal to the background reads as 1:1", () => {
  const theme = resolveTheme({
    ...BUILTIN_PALETTES.night,
    ansi: BUILTIN_PALETTES.night.ansi.map((_, slot) =>
      slot === 3 ? 0x161513 : (BUILTIN_PALETTES.night.ansi[slot] ?? 0),
    ),
  });
  expect(ansiTextContrast(theme)).toBeLessThan(AA_GRAPHIC);
  expect(ansiTextContrast(theme)).toBeCloseTo(1, 5);
});
