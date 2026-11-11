import { describe, expect, test } from "bun:test";
import { knownWidth } from "./prediction-view.ts";

describe("knownWidth", () => {
  test.each([
    ["a", 1],
    ["~", 1],
    [" ", 1],
    ["\u{AC00}", 2],
    ["\u{D7A3}", 2],
    ["\u{3131}", 2],
    ["\u{3042}", 2],
    ["\u{6C34}", 2],
    ["\u{FF21}", 2],
  ] as const)("%s takes %d cell(s), as Ghostty's table gives it", (codepoint, cells) => {
    expect(knownWidth(codepoint)).toBe(cells);
  });

  test.each([["\u{E9}"], ["\u{1F600}"], ["\u{0301}"], ["\u{7F}"]])(
    "%s is not known, so the predictor refuses it (P7) and the echo draws it",
    (codepoint) => {
      expect(knownWidth(codepoint)).toBeUndefined();
    },
  );
});
