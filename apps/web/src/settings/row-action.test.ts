import { describe, expect, test } from "bun:test";
import type { MemberEntry } from "../connection/mesh-connections.ts";
import { rowAction } from "./members-section.tsx";

const member = (hostId: string, phase: MemberEntry["state"]["phase"]): MemberEntry =>
  ({ target: { hostId }, state: { phase } }) as unknown as MemberEntry;

describe("what a machine's row offers when two are paired (#1296, #2531)", () => {
  test("a machine that is up offers nothing: no row switches which machine carries the traffic", () => {
    expect(rowAction(member("a", "open"))).toBeNull();
    expect(rowAction(member("b", "connecting"))).toBeNull();
  });

  test("a stopped machine offers Retry, which is what brings it back", () => {
    expect(rowAction(member("a", "failed"))).toBe("retry");
    expect(rowAction(member("a", "host-failed"))).toBe("retry");
  });
});
