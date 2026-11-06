import { expect, test } from "bun:test";
import { specialKeysOn } from "../keybar/catalog.ts";
import { groupedKeys, GROUP_TITLE } from "./key-groups.ts";

test("every key this host shows lands in exactly one group, so none can vanish from the sheet", () => {
  for (const host of ["mac", "other"] as const) {
    const grouped = groupedKeys(host).flatMap((group) => group.keys.map((entry) => entry.id));
    expect(grouped.toSorted()).toEqual(
      specialKeysOn(host)
        .map((entry) => entry.id)
        .toSorted(),
    );
  }
});

test("the groups come in the order the sheet draws them, each with a title", () => {
  expect(groupedKeys("mac").map((group) => group.group)).toEqual(["modifiers", "navigation", "symbols"]);
  expect(Object.values(GROUP_TITLE)).toEqual(["Modifiers", "Navigation", "Symbols"]);
});
