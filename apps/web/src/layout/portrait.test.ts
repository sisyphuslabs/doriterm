import { describe, expect, test } from "bun:test";
import type { Node } from "@doriface/protocol/layout";
import { stackRows } from "./portrait.ts";
import { arrange } from "./rects.ts";

const block = (id: string): Node => ({ content: { terminal: id }, id, type: "block" });
const box = (type: "row" | "column", id: string, children: Node[]): Node => ({ children, id, type });

describe("a split shown in portrait on a medium screen", () => {
  test("its side-by-side panes stack top to bottom, keeping their ids and sizes", () => {
    const root = box("row", "r", [{ ...block("a"), size: { weight: 2 } }, block("b")]);
    const { panes, dividers } = arrange(stackRows(root), { x: 0, y: 0, width: 800, height: 1208 }, 8);
    expect(panes.get("a")).toEqual({ x: 0, y: 0, width: 800, height: 800 });
    expect(panes.get("b")).toEqual({ x: 0, y: 808, width: 800, height: 400 });
    expect(dividers.map((divider) => [divider.container, divider.axis])).toEqual([["r", "column"]]);
  });

  test("nested rows stack as well; a tree with no row is the same tree", () => {
    const nested = box("column", "c", [block("a"), box("row", "r", [block("b"), block("c")])]);
    expect(stackRows(nested)).toEqual(box("column", "c", [block("a"), box("column", "r", [block("b"), block("c")])]));
    const columns = box("column", "c", [block("a"), block("b")]);
    expect(stackRows(columns)).toBe(columns);
  });
});
