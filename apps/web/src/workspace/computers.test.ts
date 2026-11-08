import { describe, expect, test } from "bun:test";
import type { MemberEntry } from "../connection/mesh-connections.ts";
import type { MachineEntry } from "./machines.ts";
import { unifyComputers } from "./computers.ts";

const machine = (core: string, name: string, local: boolean, state: string): MachineEntry =>
  ({ id: core, core, name, local, state, live: 0, first: undefined }) as MachineEntry;

const paired = (hostId: string, hostName: string, phase: MemberEntry["state"]["phase"]): MemberEntry =>
  ({ target: { hostId, hostName }, state: { phase } }) as unknown as MemberEntry;

describe("one list of computers (#1296)", () => {
  test("a machine both places know is one row, not two", () => {
    const list = unifyComputers([machine("core-a", "mac", true, "connected")], [paired("core-a", "mac", "open")], "core-a");
    expect(list).toHaveLength(1);
    expect(list[0]?.paired).toBe(true);
  });

  test("a machine only this app paired still gets a row", () => {
    const list = unifyComputers([machine("core-a", "mac", true, "connected")], [paired("host-b", "mini", "open")], "core-a");
    expect(list.map((c) => c.name)).toEqual(["mac", "mini"]);
    expect(list[1]?.paired).toBe(true);
  });

  test("the roster's measured state wins, and an offline machine keeps the reason it gave", () => {
    const list = unifyComputers([machine("core-b", "mini", false, "unreachable")], [paired("core-b", "mini", "open")], "core-a");
    expect(list[0]?.state).toBe("offline");
    expect(list[0]?.reason).toBe("unreachable");
  });

  test("the machine this app is attached to reads as this one", () => {
    const list = unifyComputers([], [paired("core-a", "mac", "open")], "core-a");
    expect(list[0]?.state).toBe("this");
  });

  test("a paired machine whose session dropped reads offline, not missing", () => {
    const list = unifyComputers([], [paired("host-b", "mini", "failed")], "core-a");
    expect(list[0]?.state).toBe("offline");
  });
});
