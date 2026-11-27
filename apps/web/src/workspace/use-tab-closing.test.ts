import type { Terminal } from "@doriface/protocol";
import { expect, test } from "bun:test";
import { buildTabs, TRANSIENT } from "./layout-model.ts";
import { newTabWrite, terminalRow } from "./pane-writes.ts";
import { heldClose } from "./use-tab-closing.ts";
import type { MachineLayout } from "./use-layout-docs.ts";

const here: MachineLayout = {
  machine: null,
  machineId: null,
  doc: null,
  loaded: true,
  readOnly: null,
  edit: () => Promise.resolve(true),
};

const live: Pick<Terminal, "address" | "state"> = { address: "t1", state: "live" };
const terminal: Terminal = {
  address: "t1",
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work",
  labels: {},
  screen: "exact",
  state: "live",
};

const placed = newTabWrite(
  null,
  "t1",
  { id: "tb1", name: "", root: terminalRow("tb1", "p1", "t1") },
  { id: "spc1", folder: "" },
  undefined,
  null,
).doc;

test("a close of the terminal shown alone waits while its run has not placed it, then goes ahead as its placed tab's (#2913)", () => {
  const alone = buildTabs([here], [terminal]);
  expect(alone.map((tab) => tab.key)).toEqual([TRANSIENT]);
  expect(heldClose(alone, [live], "t1")).toBe("wait");
  const saved = buildTabs([{ ...here, doc: placed }], [terminal]);
  expect(saved.map((tab) => [tab.transient, tab.panes.map((pane) => pane.address)])).toEqual([[false, ["t1"]]]);
  expect(heldClose(saved, [live], "t1")).toBe("close");
});

test("a held close waits while no tab shows the terminal yet, and is dropped once the terminal is no longer live", () => {
  expect(heldClose([], [live], "t1")).toBe("wait");
  const alone = buildTabs([here], [terminal]);
  expect(heldClose(alone, [{ address: "t1", state: "finished" }], "t1")).toBe("drop");
  expect(heldClose(alone, [], "t1")).toBe("drop");
});
