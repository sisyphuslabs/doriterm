import { describe, expect, test } from "bun:test";
import type { MemberEntry } from "../connection/mesh-connections.ts";
import { rowAction } from "./members-section.tsx";

const member = (hostId: string, phase: MemberEntry["state"]["phase"]): MemberEntry =>
  ({ target: { hostId }, state: { phase } }) as unknown as MemberEntry;

describe("what a machine's row offers when two are paired (#1296)", () => {
  test("a machine other than the attached one offers Switch to this machine", () => {
    expect(rowAction(member("a", "open"), "b")).toBe("switch");
  });

  test("the attached machine offers nothing", () => {
    expect(rowAction(member("b", "open"), "b")).toBeNull();
  });

  test("a stopped machine offers Retry, which is what brings it back, not Switch", () => {
    expect(rowAction(member("a", "failed"), "b")).toBe("retry");
    expect(rowAction(member("a", "host-failed"), "b")).toBe("retry");
  });

  test("Retry wins on the attached machine too, when it is the one in trouble", () => {
    expect(rowAction(member("b", "failed"), "b")).toBe("retry");
  });
});
