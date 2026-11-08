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

  test("the list shows from two machines, and one machine alone is not a list worth showing", () => {
    expect(summarizeMembers([member("a", "open")]).listed).toBe(false);
    expect(summarizeMembers([member("a", "open"), member("b", "failed")]).listed).toBe(true);
  });
});
