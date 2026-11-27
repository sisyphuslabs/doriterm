import { describe, expect, test } from "bun:test";
import { overflowSides } from "./tab-overflow.ts";

describe("overflowSides", () => {
  test("reports no overflow when content fits within the 1 px tolerance", () => {
    expect(overflowSides(0, 200, 200)).toEqual({ start: false, end: false });
    expect(overflowSides(0, 201, 200)).toEqual({ start: false, end: false });
    expect(overflowSides(0, 150, 200)).toEqual({ start: false, end: false });
    expect(overflowSides(0, 0, 0)).toEqual({ start: false, end: false });
    expect(overflowSides(0, 200, 0)).toEqual({ start: false, end: false });
  });

  test("reports end-only overflow when scrolled at or within 1 px of the start", () => {
    expect(overflowSides(0, 300, 200)).toEqual({ start: false, end: true });
    expect(overflowSides(1, 300, 200)).toEqual({ start: false, end: true });
    expect(overflowSides(0, 202, 200)).toEqual({ start: false, end: true });
  });

  test("reports both sides overflowing while scrolled in the middle", () => {
    expect(overflowSides(2, 300, 200)).toEqual({ start: true, end: true });
    expect(overflowSides(50, 300, 200)).toEqual({ start: true, end: true });
    expect(overflowSides(98, 300, 200)).toEqual({ start: true, end: true });
  });

  test("reports start-only overflow when scrolled at or within 1 px of the end", () => {
    expect(overflowSides(99, 300, 200)).toEqual({ start: true, end: false });
    expect(overflowSides(100, 300, 200)).toEqual({ start: true, end: false });
    expect(overflowSides(105, 300, 200)).toEqual({ start: true, end: false });
  });
});
