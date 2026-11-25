import { describe, expect, test } from "bun:test";
import type { Node } from "@doriface/protocol/layout";
import { arrangeOnHinge, hingeIn } from "./hinge.ts";

const block = (id: string): Node => ({ content: { terminal: id }, id, type: "block" });
const box = (type: "row" | "column", id: string, children: Node[]): Node => ({ children, id, type });
const BOX = { x: 0, y: 0, width: 1000, height: 600 };

describe("the hinge between two viewport segments", () => {
  test("two side-by-side segments leave a vertical hinge, in the box's own coordinates", () => {
    const segments = [
      { x: 0, y: 0, width: 540, height: 720 },
      { x: 574, y: 0, width: 540, height: 720 },
    ];
    expect(hingeIn(segments, { x: 64, y: 50, width: 1050, height: 600 })).toEqual({
      x: 476,
      y: 0,
      width: 34,
      height: 600,
    });
  });

  test("two stacked segments leave a horizontal hinge", () => {
    const segments = [
      { x: 0, y: 0, width: 720, height: 540 },
      { x: 0, y: 574, width: 720, height: 540 },
    ];
    expect(hingeIn(segments, { x: 0, y: 40, width: 720, height: 1000 })).toEqual({
      x: 0,
      y: 500,
      width: 720,
      height: 34,
    });
  });

  test("one segment, or a hinge outside the box, is no hinge", () => {
    expect(hingeIn([{ x: 0, y: 0, width: 800, height: 600 }], BOX)).toBeNull();
    const beside = [
      { x: 0, y: 0, width: 540, height: 720 },
      { x: 574, y: 0, width: 540, height: 720 },
    ];
    expect(hingeIn(beside, { x: 600, y: 0, width: 500, height: 720 })).toBeNull();
  });
});

describe("a two-pane split laid on the hinge", () => {
  const hinge = { x: 480, y: 0, width: 40, height: 600 };

  test("a row of two puts its first pane before the hinge and its second after it, with no divider to drag", () => {
    const { panes, dividers } = arrangeOnHinge(box("row", "r", [block("a"), block("b")]), BOX, 8, null, hinge);
    expect(panes.get("a")).toEqual({ x: 0, y: 0, width: 480, height: 600 });
    expect(panes.get("b")).toEqual({ x: 520, y: 0, width: 480, height: 600 });
    expect(dividers).toEqual([]);
  });

  test("each side lays out its own subtree", () => {
    const root = box("row", "r", [block("a"), box("column", "c", [block("b"), block("c")])]);
    const { panes } = arrangeOnHinge(root, BOX, 8, null, hinge);
    expect(panes.get("b")).toEqual({ x: 520, y: 0, width: 480, height: 296 });
    expect(panes.get("c")).toEqual({ x: 520, y: 304, width: 480, height: 296 });
  });

  test("a column on a horizontal hinge splits at it too", () => {
    const flat = { x: 0, y: 280, width: 1000, height: 40 };
    const { panes } = arrangeOnHinge(box("column", "c", [block("a"), block("b")]), BOX, 8, null, flat);
    expect(panes.get("a")).toEqual({ x: 0, y: 0, width: 1000, height: 280 });
    expect(panes.get("b")).toEqual({ x: 0, y: 320, width: 1000, height: 280 });
  });

  test("three panes, a cross-axis split, a zoom or no hinge keep the plain layout", () => {
    const three = box("row", "r", [block("a"), block("b"), block("c")]);
    expect(arrangeOnHinge(three, BOX, 8, null, hinge).dividers).toHaveLength(2);
    const column = box("column", "c", [block("a"), block("b")]);
    expect(arrangeOnHinge(column, BOX, 8, null, hinge).panes.get("a")?.width).toBe(1000);
    const row = box("row", "r", [block("a"), block("b")]);
    expect(arrangeOnHinge(row, BOX, 8, "a", hinge).panes.get("a")).toEqual(BOX);
    expect(arrangeOnHinge(row, BOX, 8, null, null).dividers).toHaveLength(1);
  });
});
