import { expect, test } from "bun:test";
import { type SpaceTab, spaceRowTarget } from "./phone-space.ts";

const tab = (key: string, spaceKey: string, addresses: readonly (string | null)[]): SpaceTab => ({
  key,
  spaceKey,
  panes: addresses.map((address) => ({ address })),
});

test("a space row opens the tab that space showed last", () => {
  const tabs = [tab("a", "space-1", ["addr-a"]), tab("b", "space-1", ["addr-b"])];
  expect(spaceRowTarget(tabs, "b", "space-1")).toBe("addr-b");
});

test("a space that showed no tab opens its first", () => {
  const tabs = [tab("a", "space-1", ["addr-a"]), tab("b", "space-1", ["addr-b"])];
  expect(spaceRowTarget(tabs, null, "space-1")).toBe("addr-a");
});

test("a space with no tabs opens nothing", () => {
  expect(spaceRowTarget([], null, "space-1")).toBeNull();
});

test("a tab whose panes have no address opens nothing", () => {
  expect(spaceRowTarget([tab("a", "space-1", [null])], null, "space-1")).toBeNull();
});
