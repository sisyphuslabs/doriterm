import { describe, expect, test } from "bun:test";
import type { MemberEntry } from "../connection/mesh-connections.ts";
import { summarizeMembers } from "./members-section.tsx";

const member = (hostId: string, phase: MemberEntry["state"]["phase"]): MemberEntry =>
  ({ target: { hostId }, state: { phase } }) as unknown as MemberEntry;

describe("the machines list keeps a row per member (#942 stage 6)", () => {
  test("two members, one stopped: both rows stay and only one reads connected", () => {
    const summary = summarizeMembers([member("a", "open"), member("b", "failed")]);
    expect(summary.total).toBe(2);
    expect(summary.open).toBe(1);
  });

  test("a member stopping leaves every other member listed", () => {
    const before = summarizeMembers([member("a", "open"), member("b", "open")]);
    const after = summarizeMembers([member("a", "open"), member("b", "failed")]);
    expect(before.total).toBe(2);
    expect(after.total).toBe(before.total);
    expect(after.open).toBe(1);
  });

  test("one machine alone is not a list worth showing", () => {
    expect(summarizeMembers([member("a", "open")]).total).toBe(1);
  });
});
