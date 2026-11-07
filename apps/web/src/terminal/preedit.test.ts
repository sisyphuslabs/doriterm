import { describe, expect, test } from "bun:test";
import { GhosttyCore } from "@wterm/ghostty";
import { ghosttyWasmUrl } from "@doriface/ghostty-wasm";
import { CodepointWidths, type PreeditCodepoint, preeditRange } from "./preedit.ts";

const narrow = (text: string): PreeditCodepoint => ({ text, wide: false });
const wide = (text: string): PreeditCodepoint => ({ text, wide: true });

// Ghostty's own cases for Preedit.range (src/renderer/State.zig), with max as the last column.
describe("preeditRange, as Ghostty places a preedit", () => {
  test("a narrow codepoint covers its one cell at the cursor", () => {
    expect(preeditRange([narrow("a")], 2, 9)).toEqual({ start: 2, end: 2, offset: 0 });
  });

  test("a wide codepoint covers two cells at the cursor", () => {
    expect(preeditRange([wide("\u{AC00}")], 2, 9)).toEqual({ start: 2, end: 3, offset: 0 });
  });

  test("at the last column a wide codepoint shifts left so both its cells are on the row", () => {
    expect(preeditRange([wide("\u{AC00}")], 9, 9)).toEqual({ start: 8, end: 9, offset: 0 });
  });

  test("a preedit wider than the row keeps its end and drops its first codepoints", () => {
    const text = [wide("\u{AC00}"), wide("\u{AC01}"), wide("\u{AC02}")];
    expect(preeditRange(text, 0, 3)).toEqual({ start: 0, end: 3, offset: 1 });
    expect(preeditRange(text, 2, 3)).toEqual({ start: 0, end: 3, offset: 1 });
    expect(preeditRange([narrow("a"), wide("\u{AC00}")], 2, 3)).toEqual({ start: 1, end: 3, offset: 0 });
  });
});

describe("CodepointWidths", () => {
  test("widths come from the terminal's own core: Hangul, compatibility jamo and kana are wide, ASCII is not", async () => {
    const widths = new CodepointWidths(() => GhosttyCore.load({ wasmPath: ghosttyWasmUrl }));
    try {
      expect(await widths.of("\u{D55C}a\u{3131}\u{3042}")).toEqual([
        wide("\u{D55C}"),
        narrow("a"),
        wide("\u{3131}"),
        wide("\u{3042}"),
      ]);
    } finally {
      widths.dispose();
    }
  });

  test("a codepoint already measured is answered without the core", async () => {
    let loads = 0;
    const widths = new CodepointWidths(() => {
      loads += 1;
      return GhosttyCore.load({ wasmPath: ghosttyWasmUrl });
    });
    try {
      await widths.of("\u{D55C}");
      await widths.of("\u{D55C}");
      expect(loads).toBe(1);
    } finally {
      widths.dispose();
    }
  });
});
