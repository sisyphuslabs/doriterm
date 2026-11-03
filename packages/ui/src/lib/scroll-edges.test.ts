import { describe, expect, test } from "bun:test";
import { scrollEdges } from "./scroll-edges.ts";

describe("scrollEdges", () => {
  test("a strip that fits has nothing past either edge", () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 390, clientWidth: 390 })).toEqual({ start: false, end: false });
  });

  test("an unscrolled strip wider than its box has more past the end only", () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 502, clientWidth: 390 })).toEqual({ start: false, end: true });
  });

  test("a strip scrolled to the end has more before the start only, within a pixel of rounding", () => {
    expect(scrollEdges({ scrollLeft: 111.5, scrollWidth: 502, clientWidth: 390 })).toEqual({ start: true, end: false });
  });

  test("a strip scrolled part way has more on both sides", () => {
    expect(scrollEdges({ scrollLeft: 40, scrollWidth: 502, clientWidth: 390 })).toEqual({ start: true, end: true });
  });
});
