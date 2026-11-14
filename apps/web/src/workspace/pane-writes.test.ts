import type { JsonObject } from "@doriface/protocol";
import { docSpaces, panesOf, tabsOf, terminalBlock } from "@doriface/protocol/layout";
import { describe, expect, test } from "bun:test";
import { NO_VIEW } from "../layout/view.ts";
import { apartWrite, newTabWrite, splitWrite, terminalRow, transientSplitWrite, viewInstead } from "./pane-writes.ts";

/** A layout document of one space whose tabs are rows of terminal panes (local addresses). */
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
          children: terminals.map((local, at) => ({
            id: `p${index}-${at}`,
            type: "block",
            content: { terminal: local },
          })),
        },
      })),
    },
  ],
});

/** Each tab of the document as the terminals its panes show. */
const shown = (doc: JsonObject | null): string[][] =>
  doc === null ? [] : tabsOf(doc).map((tab) => panesOf(tab.root).map((pane) => pane.terminal ?? ""));

/** Each space of the document as its id and its tabs' ids, in order. */
const spacesOf = (doc: JsonObject | null): [string, readonly string[]][] =>
  doc === null ? [] : docSpaces(doc).map((each) => [each.id, each.tabs]);

const rowOf = (id: string, pane: string, terminal: string) => ({
  id,
  root: { id, type: "row", children: [terminalBlock(pane, terminal)] },
});

const space = { id: "spc-new", folder: "" };
const split = { axis: "column" as const, block: terminalBlock("p-new", "t9"), container: "s-new" };

describe("every write that adds a pane checks the document first (#2146)", () => {
  test("keepApart writes the terminal shown alone as its own tab, and nothing once the document shows it", () => {
    expect(shown(apartWrite(null, "t1", rowOf("tb-kept", "p-kept", "t1"), space))).toEqual([["t1"]]);
    // Its machine's first adoption saved it while this write waited.
    expect(apartWrite(docOf([["t1"]]), "t1", rowOf("tb-kept", "p-kept", "t1"), space)).toBeNull();
  });

  test("a new tab writes the tab it keeps beside it, unless the document already shows that tab's terminal", () => {
    const tab = { id: "tb-new", name: "", root: rowOf("tb-new", "p-new", "t2").root };
    const kept = { terminal: "t1", tab: rowOf("tb-kept", "p-kept", "t1"), follows: true };
    expect(shown(newTabWrite(null, "t2", tab, space, undefined, kept).doc)).toEqual([["t1"], ["t2"]]);
    const adopted = newTabWrite(docOf([["t1"]]), "t2", tab, space, undefined, kept);
    expect(shown(adopted.doc)).toEqual([["t1"], ["t2"]]);
    expect(adopted.instead).toBeNull();
    // The new tab's own terminal already shown: nothing is written, and the view goes where it is.
    const both = newTabWrite(docOf([["t1"], ["t2"]]), "t2", tab, space, undefined, kept);
    expect(both).toEqual({ doc: null, instead: { tab: "tb1", pane: "p1-0" } });
  });

  test("a new tab whose kept tab was adopted while it waited goes right after the adopting tab, in its space (#2231)", () => {
    const tab = { id: "tb-new", name: "", root: rowOf("tb-new", "p-new", "t2").root };
    const kept = { terminal: "t1", tab: rowOf("tb-kept", "p-kept", "t1"), follows: true };
    // t1, the terminal the transient tab showed, was adopted into tb0 of space spc while this write waited.
    const written = newTabWrite(docOf([["t1"], ["t0"]]), "t2", tab, space, undefined, kept).doc;
    expect(spacesOf(written)).toEqual([["spc", ["tb0", "tb-new", "tb1"]]]);
  });

  test("a new tab asked for in a new space or in a named space goes there, even when its kept tab was adopted (#2231)", () => {
    const tab = { id: "tb-new", name: "", root: rowOf("tb-new", "p-new", "t2").root };
    const kept = { terminal: "t1", tab: rowOf("tb-kept", "p-kept", "t1"), follows: false };
    const fresh = newTabWrite(docOf([["t1"], ["t0"]]), "t2", tab, space, undefined, kept).doc;
    expect(spacesOf(fresh)).toEqual([
      ["spc", ["tb0", "tb1"]],
      ["spc-new", ["tb-new"]],
    ]);
    const named = newTabWrite(docOf([["t1"], ["t0"]]), "t2", tab, { id: "spc", folder: "" }, undefined, kept).doc;
    expect(spacesOf(named)).toEqual([["spc", ["tb0", "tb1", "tb-new"]]]);
  });

  test("the transient tab's split writes its tab with the new pane, or splits that terminal's pane where it was adopted", () => {
    const copy = { id: "tb-copy", pane: "p-copy", root: rowOf("tb-copy", "p-copy", "t1").root };
    const fresh = transientSplitWrite(null, "t1", "t9", copy, split, space);
    expect(shown(fresh.doc)).toEqual([["t1", "t9"]]);
    expect(fresh.instead).toBeNull();
    // The terminal shown alone was adopted into tb1 meanwhile: the new pane goes beside it there, not in a second tab.
    const beside = transientSplitWrite(docOf([["t0"], ["t1"]]), "t1", "t9", copy, split, space);
    expect(shown(beside.doc)).toEqual([["t0"], ["t1", "t9"]]);
    expect(beside.instead).toEqual({ tab: "tb1", pane: "p-new" });
  });

  test("the transient tab's split writes nothing when the document already shows the new terminal", () => {
    const copy = { id: "tb-copy", pane: "p-copy", root: rowOf("tb-copy", "p-copy", "t1").root };
    expect(transientSplitWrite(docOf([["t9"]]), "t1", "t9", copy, split, space)).toEqual({
      doc: null,
      instead: { tab: "tb0", pane: "p0-0" },
    });
  });

  test("a split writes nothing when the document already shows the new terminal, and says where it is", () => {
    expect(shown(splitWrite(docOf([["t1"]]), "tb0", "p0-0", "t9", split).doc)).toEqual([["t1", "t9"]]);
    expect(splitWrite(docOf([["t1"], ["t9"]]), "tb0", "p0-0", "t9", split)).toEqual({
      doc: null,
      instead: { tab: "tb1", pane: "p1-0" },
      gone: false,
    });
    // The pane it split closed on another device first.
    expect(splitWrite(docOf([["t2"]]), "tb0", "p-gone", "t9", split)).toEqual({ doc: null, instead: null, gone: true });
  });
});

describe("viewInstead (#2146)", () => {
  const asked = { key: "tab-a", pane: "p-new" };
  const at = { key: "tab-b", pane: "p-b" };

  test("the person still on the tab asked for is moved to where the terminal is, and that tab focuses its pane again", () => {
    const view = { ...NO_VIEW, active: "tab-a", focused: { "tab-a": "p-new" } };
    expect(viewInstead(view, asked, at, "p-a")).toEqual({
      ...NO_VIEW,
      active: "tab-b",
      focused: { "tab-a": "p-a", "tab-b": "p-b" },
    });
  });

  test("a person who moved on stays where they are", () => {
    const view = { ...NO_VIEW, active: "tab-c", focused: { "tab-a": "p-new" } };
    expect(viewInstead(view, asked, at, "p-a")).toEqual({ ...view, focused: { "tab-a": "p-a" } });
    expect(viewInstead(view, asked, at, null)).toBe(view);
  });
});

describe("terminalRow (#2470 review)", () => {
  test("is a row holding the one terminal, the shape both the new tab and the kept transient tab are written in", () => {
    expect(terminalRow("tb1", "p1", "t7")).toEqual({ children: [terminalBlock("p1", "t7")], id: "tb1", type: "row" });
  });
});
