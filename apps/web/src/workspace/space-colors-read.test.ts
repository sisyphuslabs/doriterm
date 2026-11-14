import { expect, test } from "bun:test";
import { revivedColors, saveRevived, sidebarPrefs } from "./sidebar-prefs.ts";
import { type MachineLayout, readCoresOf } from "./use-layout-docs.ts";

const layout = (
  machineId: string | null,
  readOnly: string | null,
  doc: MachineLayout["doc"] = { spaces: [] },
): MachineLayout => ({
  machine: machineId,
  machineId,
  doc,
  loaded: readOnly === null,
  readOnly,
  edit: async () => false,
});

test("only machines whose layout is read and takes edits count as read; loading, unavailable and not-connected ones keep their colours (#2585 review)", () => {
  const layouts = [
    layout(null, null),
    layout("ready", null),
    layout("loading", "the layout is loading"),
    layout("gone", "the machine is not connected"),
    layout("broken", "doc.get failed"),
  ];
  expect(readCoresOf(layouts, "core")).toEqual(["core", "ready"]);
  // A ready but empty document (none published yet) is not read either.
  expect(readCoresOf([layout("empty", null, null)], "core")).toEqual([]);
  expect(readCoresOf([layout(null, null)], "")).toEqual([]);
});

test("a space brought back after its colour was pruned this session gets that colour again (#2585 review)", () => {
  const recent = new Map([["space:m/s1", "teal" as const]]);
  expect(revivedColors({}, ["space:m/s1", "space:s2"], "c", recent)).toEqual({ "space:m/s1": "teal" });
  const kept = { "space:m/s1": "blue" } as const;
  expect(revivedColors(kept, ["space:m/s1"], "c", recent)).toBe(kept);
});

test("a colour given back is saved, so a reload keeps it too (#2585 review)", () => {
  sidebarPrefs.update({ colors: {} });
  saveRevived(["space:m/s1", "space:s2"], "c", { "space:m/s1": "teal" });
  expect(sidebarPrefs.value.colors).toEqual({ "space:m/s1": "teal" });
  saveRevived(["space:m/s1"], "c", { "space:m/s1": "blue" });
  expect(sidebarPrefs.value.colors).toEqual({ "space:m/s1": "teal" });
});
