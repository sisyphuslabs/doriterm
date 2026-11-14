import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../json.ts";
import { addTab, moveTab, tabsOf } from "./document.ts";
import { closeSet, pinEdit, placePinned, readPinsDocument, storedPins } from "./pins.ts";

const tab = (id: string): JsonObject => ({ id, name: id });
const doc = (...tabs: JsonObject[]): JsonObject => ({
  spaces: [
    { id: "s1", name: "one", folder: "/a", tabs },
    { id: "s2", name: "two", folder: "/b", tabs: [tab("z")] },
  ],
});
const pinsOf = (...ids: string[]): ReadonlySet<string> => new Set(ids);
/** Reads the document's own tab order, with no pins to bring forward. */
const NO_PINS_READ: ReadonlySet<string> = new Set();
const order = (value: JsonObject | null, pins: ReadonlySet<string>): string[] =>
  value === null
    ? []
    : tabsOf(value, pins).flatMap((each) => (each.space === "s1" ? [`${each.id}${each.pinned ? "*" : ""}`] : []));

/** Pins tab `id` as the app does: placed in the herdr-app document, named in the pins document. */
function pin(
  layout: JsonObject,
  pinsDoc: JsonObject | null,
  id: string,
  pinned: boolean,
): { layout: JsonObject; pins: JsonObject | null } {
  const live = tabsOf(layout).map((each) => each.id);
  return {
    layout: placePinned(layout, id, storedPins(pinsDoc)) ?? layout,
    pins: pinEdit(live, id, pinned)(pinsDoc) ?? pinsDoc,
  };
}

describe("pinning a tab (#1561)", () => {
  test("a pinned tab moves to the end of its space's pinned tabs and reads as pinned", () => {
    const first = pin(doc(tab("a"), tab("b"), tab("c")), null, "c", true);
    expect(order(first.layout, storedPins(first.pins))).toEqual(["c*", "a", "b"]);
    const second = pin(first.layout, first.pins, "b", true);
    expect(order(second.layout, storedPins(second.pins))).toEqual(["c*", "b*", "a"]);
  });

  test("an unpinned tab moves to the start of the unpinned tabs", () => {
    const unpinned = pin(doc(tab("a"), tab("b"), tab("c")), { pinned_tabs: ["a", "b"] }, "a", false);
    expect(order(unpinned.layout, storedPins(unpinned.pins))).toEqual(["b*", "a", "c"]);
  });

  test("pinning a pinned tab, or a tab that is gone, writes nothing", () => {
    expect(pinEdit(["a"], "a", true)({ pinned_tabs: ["a"] })).toBeNull();
    expect(pinEdit(["a"], "a", false)(null)).toBeNull();
    expect(placePinned(doc(tab("a")), "gone", pinsOf())).toBeNull();
    expect(placePinned(doc(tab("a"), tab("b")), "a", pinsOf())).toBeNull();
  });

  test("the pins document keeps its other fields and drops ids of tabs closed since", () => {
    expect(pinEdit(["a", "b"], "b", true)({ pinned_tabs: ["a", "gone"], kept: 1 })).toEqual({
      pinned_tabs: ["a", "b"],
      kept: 1,
    });
  });

  test("the herdr-app document gets no pin field, and other spaces and fields stay as read", () => {
    const pinned = placePinned(doc(tab("a"), tab("b")), "b", pinsOf());
    expect(pinned?.["spaces"]).toEqual([
      { id: "s1", name: "one", folder: "/a", tabs: [tab("b"), tab("a")] },
      { id: "s2", name: "two", folder: "/b", tabs: [tab("z")] },
    ]);
  });

  test("a pins document that is not a list of tab ids is not read", () => {
    expect(readPinsDocument(null)).toEqual({ kind: "empty" });
    expect(readPinsDocument({ pinned_tabs: "a" })).toEqual({
      kind: "unreadable",
      reason: "pinned tabs that are not a list of tab ids",
    });
    expect(readPinsDocument({ pinned_tabs: ["a"] })).toEqual({ kind: "ok", doc: { pinned_tabs: ["a"] } });
  });
});

/** herdr-app saving its layout (`src/mirror.rs`): the document rebuilt from its fixed struct, so any other tab field goes. */
const herdrResave = (value: JsonObject): JsonObject => ({
  spaces: ((value["spaces"] ?? []) as JsonObject[]).map((space) => ({
    id: space["id"] ?? "",
    name: space["name"] ?? "",
    folder: space["folder"] ?? "",
    tabs: ((space["tabs"] ?? []) as JsonObject[]).map((each) => ({
      id: each["id"] ?? "",
      name: each["name"] ?? "",
      root: each["root"] ?? null,
    })),
  })),
});

describe("a pin survives herdr-app saving its layout (#1621 review)", () => {
  test("a pinned tab still reads as pinned after herdr-app rewrites its document", () => {
    const pinned = pin(doc(tab("a"), tab("b")), null, "b", true);
    expect(pinned.pins).not.toBeNull();
    expect(order(herdrResave(pinned.layout), storedPins(pinned.pins))).toEqual(["b*", "a"]);
  });
});

describe("a move keeps pinned tabs in front (#1561)", () => {
  const four = doc(tab("p1"), tab("p2"), tab("u1"), tab("u2"));
  const pins = pinsOf("p1", "p2");

  test("a pinned tab moves only among the pinned ones", () => {
    expect(order(moveTab(four, "p1", 3, pins), pins)).toEqual(["p2*", "p1*", "u1", "u2"]);
    expect(moveTab(four, "p1", 0, pins)).toBeNull();
  });

  test("an unpinned tab moves only among the unpinned ones", () => {
    expect(order(moveTab(four, "u2", 0, pins), pins)).toEqual(["p1*", "p2*", "u2", "u1"]);
    expect(moveTab(four, "u1", 1, pins)).toBeNull();
  });
});

describe("pinned tabs read first even when the document has them elsewhere (#1916)", () => {
  // Written by an older client, or herdr-app after a tab was added past a pinned one: a pinned tab in the middle.
  const middle = doc(tab("a"), tab("b"), tab("c"));
  test("a pinned tab reads in front, and the others keep their order", () => {
    expect(order(middle, pinsOf("b"))).toEqual(["b*", "a", "c"]);
  });
  test("a move is placed in the order as read, and writes the pinned tab in front", () => {
    expect(order(moveTab(middle, "c", 1, pinsOf("b")), NO_PINS_READ)).toEqual(["b", "c", "a"]);
  });
  test("Close tabs to the right from that pinned tab takes the tabs shown after it", () => {
    expect(closeSet(middle, "b", "right", pinsOf("b"))).toEqual(["a", "c"]);
  });
  test("a tab pinned next lands after it, not before it", () => {
    const pins = pinsOf("b", "c");
    expect(order(placePinned(middle, "c", pinsOf("b")), pins)).toEqual(["b*", "c*", "a"]);
    expect(order(placePinned(middle, "c", pinsOf("b")), NO_PINS_READ)).toEqual(["b", "c", "a"]);
  });
});

describe("a new tab never lands between pinned tabs (#1561 review)", () => {
  const space = { id: "s1", folder: "/a" };
  test("opened from a pinned tab, it lands after the last pinned tab", () => {
    const pins = pinsOf("a", "b");
    expect(order(addTab(doc(tab("a"), tab("b"), tab("c")), space, tab("n"), "a", pins), pins)).toEqual([
      "a*",
      "b*",
      "n",
      "c",
    ]);
  });

  test("opened from an unpinned tab, or with no tab named, it lands where it did", () => {
    const pins = pinsOf("a");
    expect(order(addTab(doc(tab("a"), tab("b"), tab("c")), space, tab("n"), "b", pins), pins)).toEqual([
      "a*",
      "b",
      "n",
      "c",
    ]);
    expect(order(addTab(doc(tab("a"), tab("b")), space, tab("n"), undefined, pins), pins)).toEqual(["a*", "b", "n"]);
  });
});

describe("the tabs a close-to-the-right or close-others closes (#1561)", () => {
  const five = doc(tab("p1"), tab("a"), tab("b"), tab("c"), tab("d"));
  const pins = pinsOf("p1");

  test("to the right: the tabs after it in its space, never a pinned one", () => {
    expect(closeSet(five, "b", "right", pins)).toEqual(["c", "d"]);
    expect(closeSet(five, "p1", "right", pins)).toEqual(["a", "b", "c", "d"]);
    expect(closeSet(five, "d", "right", pins)).toEqual([]);
  });

  test("others: every other tab of its space, never a pinned one", () => {
    expect(closeSet(five, "b", "others", pins)).toEqual(["a", "c", "d"]);
    expect(closeSet(five, "p1", "others", pins)).toEqual(["a", "b", "c", "d"]);
    expect(closeSet(five, "gone", "others", pins)).toEqual([]);
  });
});
