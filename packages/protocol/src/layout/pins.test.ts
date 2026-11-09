import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../json.ts";
import { moveTab, tabsOf } from "./document.ts";
import { closeSet, setPinned } from "./pins.ts";

const tab = (id: string, pinned = false): JsonObject => ({ id, name: id, ...(pinned ? { pinned: true } : {}) });
const doc = (...tabs: JsonObject[]): JsonObject => ({
  spaces: [
    { id: "s1", name: "one", folder: "/a", tabs },
    { id: "s2", name: "two", folder: "/b", tabs: [tab("z")] },
  ],
});
const order = (value: JsonObject | null): string[] =>
  value === null
    ? []
    : tabsOf(value).flatMap((each) => (each.space === "s1" ? [`${each.id}${each.pinned ? "*" : ""}`] : []));

describe("pinning a tab (#1561)", () => {
  test("a pinned tab moves to the end of its space's pinned tabs and reads as pinned", () => {
    expect(order(setPinned(doc(tab("a"), tab("b"), tab("c")), "c", true))).toEqual(["c*", "a", "b"]);
    expect(order(setPinned(doc(tab("a", true), tab("b"), tab("c")), "c", true))).toEqual(["a*", "c*", "b"]);
  });

  test("an unpinned tab moves to the start of the unpinned tabs", () => {
    expect(order(setPinned(doc(tab("a", true), tab("b", true), tab("c")), "a", false))).toEqual(["b*", "a", "c"]);
  });

  test("pinning a pinned tab, or a tab that is gone, writes nothing", () => {
    expect(setPinned(doc(tab("a", true)), "a", true)).toBeNull();
    expect(setPinned(doc(tab("a")), "a", false)).toBeNull();
    expect(setPinned(doc(tab("a")), "gone", true)).toBeNull();
  });

  test("other spaces and fields stay as read", () => {
    const pinned = setPinned(doc(tab("a"), tab("b")), "b", true);
    expect(pinned?.["spaces"]).toEqual([
      { id: "s1", name: "one", folder: "/a", tabs: [tab("b", true), tab("a")] },
      { id: "s2", name: "two", folder: "/b", tabs: [tab("z")] },
    ]);
  });
});

describe("a move keeps pinned tabs in front (#1561)", () => {
  const four = doc(tab("p1", true), tab("p2", true), tab("u1"), tab("u2"));

  test("a pinned tab moves only among the pinned ones", () => {
    expect(order(moveTab(four, "p1", 3))).toEqual(["p2*", "p1*", "u1", "u2"]);
    expect(moveTab(four, "p1", 0)).toBeNull();
  });

  test("an unpinned tab moves only among the unpinned ones", () => {
    expect(order(moveTab(four, "u2", 0))).toEqual(["p1*", "p2*", "u2", "u1"]);
    expect(moveTab(four, "u1", 1)).toBeNull();
  });
});

describe("the tabs a close-to-the-right or close-others closes (#1561)", () => {
  const five = doc(tab("p1", true), tab("a"), tab("b"), tab("c"), tab("d"));

  test("to the right: the tabs after it in its space, never a pinned one", () => {
    expect(closeSet(five, "b", "right")).toEqual(["c", "d"]);
    expect(closeSet(five, "p1", "right")).toEqual(["a", "b", "c", "d"]);
    expect(closeSet(five, "d", "right")).toEqual([]);
  });

  test("others: every other tab of its space, never a pinned one", () => {
    expect(closeSet(five, "b", "others")).toEqual(["a", "c", "d"]);
    expect(closeSet(five, "p1", "others")).toEqual(["a", "b", "c", "d"]);
    expect(closeSet(five, "gone", "others")).toEqual([]);
  });
});
