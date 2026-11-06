import { expect, test } from "bun:test";
import { BUILTIN_PALETTES, BUILTIN_THEMES } from "./builtins.ts";
import { contrast } from "./color.ts";
import { AA_GRAPHIC } from "./guard.ts";
import { LIBRARY_CREDITS } from "./library.ts";
import { resolveTheme } from "./resolve.ts";

const entries = Object.entries(BUILTIN_PALETTES);

test("twenty dark and twenty light themes are built in", () => {
  const light = entries.filter(([, palette]) => resolveTheme(palette).light).map(([id]) => id);
  expect(entries).toHaveLength(40);
  expect(light).toHaveLength(20);
});

test("every built-in theme has its own name", () => {
  const names = Object.values(BUILTIN_THEMES).map((info) => info.name);
  expect(new Set(names).size).toBe(entries.length);
  expect(Object.keys(BUILTIN_THEMES).toSorted()).toEqual(Object.keys(BUILTIN_PALETTES).toSorted());
});

test.each(Object.entries(LIBRARY_CREDITS))("%s credits its project under a licence Doriterm can ship", (_, credit) => {
  expect(credit.url).toStartWith("https://github.com/");
  expect(["MIT", "Apache-2.0"]).toContain(credit.licence);
});

test.each(entries)("%s keeps terminal text readable on its selection", (_, palette) => {
  expect(contrast(palette.foreground, palette.selection)).toBeGreaterThanOrEqual(AA_GRAPHIC);
});
