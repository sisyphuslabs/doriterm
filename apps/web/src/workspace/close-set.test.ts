import { describe, expect, test } from "bun:test";
import type { LayoutTab } from "./layout-model.ts";
import { stillClosing } from "./close-set.ts";

const tab = (key: string, pinned = false): LayoutTab =>
  ({ key, id: key, space: "s", spaceKey: "s", machine: null, name: key, pinned, panes: [], transient: false }) as never;

describe("a pending close set reads the tabs as they are now (#1621 review)", () => {
  test("a tab pinned after the set was chosen, here or on another device, is spared", () => {
    const chosen = ["b", "c"];
    expect(stillClosing([tab("a"), tab("b", true), tab("c")], chosen).map((each) => each.key)).toEqual(["c"]);
  });

  test("a tab already gone is skipped, and an untouched set closes as chosen", () => {
    expect(stillClosing([tab("a"), tab("c")], ["b", "c"]).map((each) => each.key)).toEqual(["c"]);
    expect(stillClosing([tab("a"), tab("b"), tab("c")], ["b", "c"]).map((each) => each.key)).toEqual(["b", "c"]);
  });
});
