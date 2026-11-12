import { expect, test } from "bun:test";
import { dirname, join } from "node:path";

/**
 * The composing box of the installed (patched) @wterm/dom spans the cells Ghostty gives what is being composed. Its
 * input.js is loaded by path: the package exports only its index, and the width is read from the handler's method with
 * a stand-in field, so no DOM is needed (#1285).
 */
const input = join(dirname(Bun.resolveSync("@wterm/dom", import.meta.dir)), "input.js");
const { InputHandler } = (await import(input)) as {
  InputHandler: { prototype: { compositionCells(this: { textarea: { value: string } }, charWidth: number): number } };
};

function cells(value: string): number {
  return InputHandler.prototype.compositionCells.call({ textarea: { value } }, 1);
}

test.each([
  ["a Hangul syllable", "\u{D55C}", 2],
  ["a CJK ideograph", "\u{4E00}", 2],
  ["an emoji with emoji presentation", "\u{1F680}", 2],
  ["an emoji with text presentation", "\u{1F321}", 1],
  ["an emoji with text presentation and VS15", "\u{1F321}\uFE0E", 1],
  ["a thermometer with VS16", "\u{1F321}\uFE0F", 2],
  ["a desktop computer with VS16", "\u{1F5A5}\uFE0F", 2],
  ["a hot pepper with VS16", "\u{1F336}\uFE0F", 2],
  ["a dove with VS16", "\u{1F54A}\uFE0F", 2],
  ["Latin letters", "ni", 2],
] as const)("the composing box spans the cells the grid gives %s (#1285)", (_name, value, expected) => {
  expect(cells(value)).toBe(expected);
});
