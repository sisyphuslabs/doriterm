import { describe, expect, test } from "bun:test";
import { memberReach } from "./member-reach.ts";

describe("what this client can reach, from its own sessions (#942 stage 6)", () => {
  test("a member the host says is present, but whose own session closed, is not reachable", () => {
    expect(memberReach({ line: "connected", presence: true }, "closed")).toBe("no-session");
  });

  test("a member whose own session is open is reachable even when the host's document disagrees", () => {
    expect(memberReach({ line: "absent", presence: false }, "connected")).toBe("open-session");
  });

  test("this host is still itself", () => {
    expect(memberReach({ line: "self", presence: true }, "connected")).toBe("this-host");
  });

  test("a member with no session of its own falls back to what the host reports", () => {
    expect(memberReach({ line: "connected", presence: true }, "unknown")).toBe("open-session");
  });
});
