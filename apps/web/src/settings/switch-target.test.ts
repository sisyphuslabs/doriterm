import { describe, expect, test } from "bun:test";
import type { MemberEntry } from "../connection/mesh-connections.ts";
import { switchTarget } from "./members-section.tsx";

const member = (hostId: string, phase: MemberEntry["state"]["phase"]): MemberEntry =>
  ({ target: { hostId }, state: { phase } }) as unknown as MemberEntry;

describe("switching between two paired machines (#1296)", () => {
  const both = [member("a", "open"), member("b", "open")];

  test("the attached machine is not offered as a target", () => {
    expect(switchTarget(both, "b")).toBe("a");
    expect(switchTarget(both, "a")).toBe("b");
  });

  test("a single machine has nothing to switch to", () => {
    expect(switchTarget([member("a", "open")], "a")).toBeUndefined();
  });

  test("a stopped machine is still a switch target, so its row can bring it back", () => {
    expect(switchTarget([member("a", "open"), member("b", "failed")], "a")).toBe("b");
  });
});
