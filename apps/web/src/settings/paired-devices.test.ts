import { describe, expect, test } from "bun:test";
import { deviceSummary, pairedDevicesView } from "./paired-devices.ts";

const phone = { name: "phone", id: "3FA94C0E", pairedAt: "2026-11-06T07:00:00.000Z" } as const;

describe("what Settings says about this computer's paired devices", () => {
  test("a build with no shell call offers nothing rather than an empty list", () => {
    expect(pairedDevicesView(null, false)).toEqual({ kind: "unsupported" });
    expect(pairedDevicesView({ state: "listed", devices: [phone] }, false)).toEqual({ kind: "unsupported" });
  });

  test("nothing read yet is asking, and a host that refused says why", () => {
    expect(pairedDevicesView(null)).toEqual({ kind: "asking" });
    expect(pairedDevicesView({ state: "unavailable", reason: "the host refused" })).toEqual({
      kind: "failed",
      reason: "the host refused",
    });
  });

  test("an empty list is its own state, not a failure or a list of nothing", () => {
    expect(pairedDevicesView({ state: "listed", devices: [] })).toEqual({ kind: "empty" });
    expect(pairedDevicesView({ state: "listed", devices: [phone] })).toEqual({ kind: "listed", devices: [phone] });
  });

  test("a row names the id a member reads on the other device, and drops an unreadable date rather than printing it", () => {
    expect(deviceSummary(phone)).toStartWith("3FA94C0E");
    expect(deviceSummary({ ...phone, pairedAt: "not a date" })).toBe("3FA94C0E");
  });
});
