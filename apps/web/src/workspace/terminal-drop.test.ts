import type { JsonObject } from "@doriface/protocol";
import { childrenOf, idOf, panesOf, tabsOf, typeOf, type Node } from "@doriface/protocol/layout";
import { describe, expect, test } from "bun:test";
import { detachPaneWrite, tabDropWrite, terminalDropWrite } from "./terminal-drop.ts";

/** A layout document of one space whose tabs are rows of terminal panes (local addresses); pane ids are `p<terminal>`. */
const docOf = (tabs: readonly (readonly string[])[]): JsonObject => ({
  spaces: [
    {
      id: "spc",
      name: "",
      folder: "/w",
      tabs: tabs.map((terminals, index) => ({
        id: `tb${index}`,
        name: "",
        root: {
          id: `tb${index}`,
          type: "row",
          children: terminals.map((local) => ({ id: `p${local}`, type: "block", content: { terminal: local } })),
        },
      })),
    },
  ],
});

/** A tree as `row(a,column(b,c))` by terminal, so where each pane went reads at a glance. */
function outline(node: Node): string {
  const children = childrenOf(node);
  if (typeOf(node) === "block") return idOf(node).slice(1);
  return `${typeOf(node)}(${children.map(outline).join(",")})`;
}

/** Each tab of the document as `tab:outline`. */
const tabs = (doc: JsonObject | null | undefined): string[] =>
  doc === null || doc === undefined ? [] : tabsOf(doc).map((tab) => `${tab.id}:${outline(tab.root)}`);

const fresh = { pane: "pnew", container: "s-new" };

describe("a terminal dropped from the sidebar onto a pane", () => {
  test("from another tab, on an edge: it leaves that tab, which goes with its last pane, and splits the target", () => {
    const doc = docOf([["t1", "t2"], ["t3"]]);
    const right = terminalDropWrite(doc, "t3", { tab: "tb0", target: "pt2", zone: "right" }, fresh);
    expect(tabs(right?.doc)).toEqual(["tb0:row(t1,t2,t3)"]);
    expect(right?.pane).toBe("pt3");
    const top = terminalDropWrite(doc, "t3", { tab: "tb0", target: "pt1", zone: "top" }, fresh);
    expect(tabs(top?.doc)).toEqual(["tb0:row(column(t3,t1),t2)"]);
  });

  test("from a tab of several panes: that tab keeps the others", () => {
    const doc = docOf([["t1"], ["t2", "t3"]]);
    const left = terminalDropWrite(doc, "t3", { tab: "tb0", target: "pt1", zone: "left" }, fresh);
    expect(tabs(left?.doc)).toEqual(["tb0:row(t3,t1)", "tb1:row(t2)"]);
  });

  test("from another tab, in the middle: the two trade places, each keeping its tab", () => {
    const doc = docOf([
      ["t1", "t2"],
      ["t3", "t4"],
    ]);
    const swap = terminalDropWrite(doc, "t3", { tab: "tb0", target: "pt2", zone: "swap" }, fresh);
    expect(tabs(swap?.doc)).toEqual(["tb0:row(t1,t3)", "tb1:row(t2,t4)"]);
    expect(swap?.pane).toBe("pt3");
  });

  test("from the same tab: it moves as a dragged pane does", () => {
    const doc = docOf([["t1", "t2", "t3"]]);
    expect(tabs(terminalDropWrite(doc, "t1", { tab: "tb0", target: "pt3", zone: "right" }, fresh)?.doc)).toEqual([
      "tb0:row(t2,t3,t1)",
    ]);
    expect(tabs(terminalDropWrite(doc, "t1", { tab: "tb0", target: "pt3", zone: "swap" }, fresh)?.doc)).toEqual([
      "tb0:row(t3,t2,t1)",
    ]);
  });

  test("shown by no pane: it gets a new pane, and in the middle takes the target's place", () => {
    const doc = docOf([["t1", "t2"]]);
    const below = terminalDropWrite(doc, "t9", { tab: "tb0", target: "pt2", zone: "bottom" }, fresh);
    expect(tabs(below?.doc)).toEqual(["tb0:row(t1,column(t2,new))"]);
    expect(below?.pane).toBe("pnew");
    const instead = terminalDropWrite(doc, "t9", { tab: "tb0", target: "pt2", zone: "swap" }, fresh);
    expect(tabs(instead?.doc)).toEqual(["tb0:row(t1,new)"]);
    expect(instead === null ? [] : panesOf(tabsOf(instead.doc)[0]?.root ?? {}).map((pane) => pane.terminal)).toEqual([
      "t1",
      "t9",
    ]);
  });

  test("writes nothing on its own pane, on a target that is gone, or with no document", () => {
    const doc = docOf([["t1", "t2"]]);
    expect(terminalDropWrite(doc, "t2", { tab: "tb0", target: "pt2", zone: "left" }, fresh)).toBeNull();
    expect(terminalDropWrite(doc, "t9", { tab: "tb0", target: "pgone", zone: "left" }, fresh)).toBeNull();
    expect(terminalDropWrite(doc, "t9", { tab: "tb-gone", target: "pt1", zone: "left" }, fresh)).toBeNull();
    expect(terminalDropWrite(null, "t9", { tab: "tb0", target: "pt1", zone: "left" }, fresh)).toBeNull();
  });
});

describe("a tab dragged from the tab strip onto a pane", () => {
  test("single-pane tab on an edge removes the source tab and splits the target", () => {
    const doc = docOf([["t1"], ["t2"]]);
    const right = tabDropWrite(doc, "tb1", { tab: "tb0", target: "pt1", zone: "right" }, "s-split");
    expect(tabs(right?.doc)).toEqual(["tb0:row(t1,t2)"]);
    expect(right?.pane).toBe("pt2");

    const top = tabDropWrite(doc, "tb1", { tab: "tb0", target: "pt1", zone: "top" }, "s-split");
    expect(tabs(top?.doc)).toEqual(["tb0:row(column(t2,t1))"]);
    expect(top?.pane).toBe("pt2");
  });

  test("single-pane tab in the middle swaps places with the target pane", () => {
    const doc = docOf([["t1", "t2"], ["t3"]]);
    const swapped = tabDropWrite(doc, "tb1", { tab: "tb0", target: "pt2", zone: "swap" }, "s-split");
    expect(tabs(swapped?.doc)).toEqual(["tb0:row(t1,t3)", "tb1:row(t2)"]);
    expect(swapped?.pane).toBe("pt3");
  });

  test("multi-pane tab on any edge docks its whole subtree and removes the source tab", () => {
    const doc = docOf([["t1"], ["t2", "t3"]]);
    const left = tabDropWrite(doc, "tb1", { tab: "tb0", target: "pt1", zone: "left" }, "s-split");
    expect(tabs(left?.doc)).toEqual(["tb0:row(row(row(t2,t3),t1))"]);
    expect(left?.pane).toBe("pt2");

    const bottom = tabDropWrite(doc, "tb1", { tab: "tb0", target: "pt1", zone: "bottom" }, "s-split");
    expect(tabs(bottom?.doc)).toEqual(["tb0:row(column(t1,row(t2,t3)))"]);
    expect(bottom?.pane).toBe("pt2");
  });

  test("multi-pane tab in the middle trades places with the target pane", () => {
    const doc = docOf([["t1"], ["t2", "t3"]]);
    const swapped = tabDropWrite(doc, "tb1", { tab: "tb0", target: "pt1", zone: "swap" }, "s-split");
    expect(tabs(swapped?.doc)).toEqual(["tb0:row(row(t2,t3))", "tb1:t1"]);
    expect(swapped?.pane).toBe("pt2");
  });

  test("rejects dropping a tab onto itself or missing targets", () => {
    const doc = docOf([["t1"], ["t2"]]);
    expect(tabDropWrite(doc, "tb0", { tab: "tb0", target: "pt1", zone: "right" }, "s-split")).toBeNull();
    expect(tabDropWrite(doc, "tb-gone", { tab: "tb0", target: "pt1", zone: "right" }, "s-split")).toBeNull();
    expect(tabDropWrite(doc, "tb1", { tab: "tb0", target: "pgone", zone: "right" }, "s-split")).toBeNull();
    expect(tabDropWrite(null, "tb1", { tab: "tb0", target: "pt1", zone: "right" }, "s-split")).toBeNull();
  });
});

describe("detaching a pane from a split tab into its own tab", () => {
  test("removes the pane from its split tab and inserts a new tab right after it keeping the pane id", () => {
    const doc = docOf([["t1", "t2"], ["t3"]]);
    const detached = detachPaneWrite(doc, "tb0", "pt2", "tb-pop");
    expect(tabs(detached?.doc)).toEqual(["tb0:row(t1)", "tb-pop:t2", "tb1:row(t3)"]);
    expect(detached?.tab).toBe("tb-pop");
    expect(detached?.pane).toBe("pt2");
  });

  test("rejects a single-pane tab or missing pane", () => {
    const doc = docOf([["t1"], ["t2", "t3"]]);
    expect(detachPaneWrite(doc, "tb0", "pt1", "tb-pop")).toBeNull();
    expect(detachPaneWrite(doc, "tb1", "pgone", "tb-pop")).toBeNull();
    expect(detachPaneWrite(null, "tb1", "pt2", "tb-pop")).toBeNull();
  });
});
