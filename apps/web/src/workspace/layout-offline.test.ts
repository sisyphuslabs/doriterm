import type { JsonObject } from "@doriface/protocol";
import { expect, test } from "bun:test";
import { buildTabs } from "./layout-model.ts";
import type { MachineLayout } from "./use-layout-docs.ts";

const saved: JsonObject = {
  spaces: [
    {
      id: "spc1",
      name: "",
      tabs: [
        {
          id: "tb1",
          name: "",
          root: {
            id: "tb1",
            type: "row",
            children: [{ id: "p1", type: "block", content: { terminal: "t1" } }],
          },
        },
      ],
    },
  ],
};

for (const doc of [null, saved]) {
  test.each([
    { reason: "the layout is loading", offline: false },
    { reason: "this layout has a newer version, which this version of Doriterm cannot edit", offline: false },
    { reason: "the machine is reconnecting", offline: false },
    { reason: "the machine is not connected", offline: true },
  ])(
    `a ${doc === null ? "loose" : "document"} tab keeps machine reachability separate from $reason`,
    ({ reason, offline }) => {
      const owner = {
        machine: "box",
        machineId: "box-id",
        doc,
        loaded: doc !== null,
        readOnly: reason,
        offline,
        edit: () => Promise.resolve(false),
      } satisfies MachineLayout;

      const tabs = buildTabs([owner], [], ["box/t1"]);

      expect(tabs).toHaveLength(1);
      expect(tabs[0]?.offline).toBe(offline);
      expect(tabs[0]?.readOnly).toBe(reason);
    },
  );
}

test("a loose tab whose owner is missing stays offline", () => {
  const tabs = buildTabs([], [], ["missing/t1"]);

  expect(tabs).toHaveLength(1);
  expect(tabs[0]?.offline).toBe(true);
});
