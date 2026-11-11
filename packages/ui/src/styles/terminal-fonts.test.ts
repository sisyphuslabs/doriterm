import { expect, test } from "bun:test";

const read = (name: string): Promise<string> => Bun.file(new URL(name, import.meta.url)).text();

/** The families of a `font-family` value, in the order the browser tries them. */
function families(value: string): string[] {
  return value.split(",").map((family) => family.trim().replace(/^"|"$/g, ""));
}

test("the terminal stack draws Powerline before any face the platform may not have (#1403)", async () => {
  const tokens = await read("./tokens.css");
  const declared = tokens.match(/--font-term:\s*([^;]+);/s)?.[1];
  expect(declared).toBeDefined();
  const stack = families(declared ?? "");
  const powerline = stack.indexOf("Doriterm Powerline");
  // JetBrains Mono stays the face for Latin and its own seven separator glyphs; the subset only fills what it lacks.
  expect(stack[0]).toBe("JetBrains Mono Variable");
  expect(powerline).toBeGreaterThan(stack.indexOf("JetBrains Mono"));
  // Before every fallback: the generic mono, the Hangul faces and the emoji faces are all after it.
  expect(powerline).toBeLessThan(stack.indexOf("ui-monospace"));
  expect(powerline).toBeLessThan(stack.indexOf("Apple SD Gothic Neo"));
  expect(powerline).toBeLessThan(stack.indexOf("Symbols Nerd Font Mono"));
});

test("the Powerline face is exactly the eight separators, from a small committed subset with its licence (#1403)", async () => {
  const css = await read("./terminal-fonts.css");
  const face = css.match(/@font-face\s*\{[^}]*font-family:\s*"Doriterm Powerline"[^}]*\}/s)?.[0] ?? "";
  expect(face).toContain('url("./fonts/powerline-symbols.woff2")');
  expect(face).toContain("unicode-range: U+E0A0-E0A3, U+E0B0-E0B3");
  const font = Bun.file(new URL("./fonts/powerline-symbols.woff2", import.meta.url));
  expect(await font.exists()).toBe(true);
  // Subset only the eight codepoints: the icon face next to it is 1.2 MB, this must stay far below it.
  expect(font.size).toBeLessThan(8 * 1024);
  expect(await Bun.file(new URL("./fonts/LICENSE-doriterm-powerline.txt", import.meta.url)).exists()).toBe(true);
});
