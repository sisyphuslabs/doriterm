import { expect, test } from "bun:test";
import type { LayoutTab } from "./layout-model.ts";
import { writableDrops } from "./use-drop-pane.ts";

const tab = (key: string, machine: string | null, addresses: readonly string[]): LayoutTab => ({
  key,
  id: key,
  space: "s",
  spaceKey: "space:s",
  machine,
  name: "",
  root: { children: [], id: key, type: "row" },
  panes: addresses.map((address, index) => ({ id: `${key}-p${index}`, address, mod: null })),
  readOnly: null,
  pinned: false,
  transient: false,
});

test("a drop waits for its machine's layout to take edits, and one whose pane is gone is let go", () => {
  const tabs = [tab("here", null, ["t1"]), tab("box", "box", ["box/t2", "box/t3"])];
  const pending = ["t1", "box/t2", "gone"];
  expect(writableDrops(pending, tabs, (machine) => machine === null)).toEqual({ now: ["t1"], gone: ["gone"] });
  expect(writableDrops(pending, tabs, () => true)).toEqual({ now: ["t1", "box/t2"], gone: ["gone"] });
  expect(writableDrops(pending, tabs, () => false)).toEqual({ now: [], gone: ["gone"] });
});
