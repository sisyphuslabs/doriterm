import { expect, test } from "bun:test";
import { LAYOUT_LOADING, type MachineLayout, restoredFrom, unreadReason } from "./use-layout-docs.ts";

const FAILED = "doc.get did not answer in time";

const layout = (fields: Partial<MachineLayout>): MachineLayout => ({
  machine: null,
  machineId: null,
  doc: null,
  loaded: true,
  unread: null,
  readOnly: null,
  edit: () => Promise.resolve(true),
  ...fields,
});

test("a layout whose first read failed is not a restored, empty screen: the person is told why instead (#2443)", () => {
  const failedFirstRead = layout({ loaded: false, unread: FAILED, readOnly: FAILED });

  expect(restoredFrom([failedFirstRead], true)).toBe(false);
  expect(unreadReason([failedFirstRead])).toBe(FAILED);
});

test("a failed re-read of a layout already read keeps that screen, and a machine that is not connected is not waited for", () => {
  const keptAfterFailedReread = layout({ loaded: true, unread: FAILED, readOnly: FAILED });
  const notConnected = layout({
    machine: "bee",
    machineId: "bee-id",
    loaded: false,
    readOnly: "the machine is not connected",
  });

  expect(restoredFrom([keptAfterFailedReread, notConnected], true)).toBe(true);
  expect(unreadReason([keptAfterFailedReread, notConnected])).toBeNull();
});

test("a layout still loading, or a machine list not answered yet, is not restored", () => {
  expect(restoredFrom([layout({ loaded: false, readOnly: LAYOUT_LOADING })], true)).toBe(false);
  expect(restoredFrom([layout({})], false)).toBe(false);
  expect(restoredFrom([layout({})], true)).toBe(true);
});
