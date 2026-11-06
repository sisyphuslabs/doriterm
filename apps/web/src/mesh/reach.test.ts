import { describe, expect, test } from "bun:test";
import { reachOf } from "./reach.ts";

describe("whether this host is exchanging with a member", () => {
  test("the member that is this host is itself", () => {
    expect(reachOf({ line: "self", presence: true })).toBe("this-host");
  });

  test("an open session is one, whatever line state the reconciler last wrote", () => {
    expect(reachOf({ line: "connected", presence: true })).toBe("open-session");
    expect(reachOf({ line: "connecting", presence: true })).toBe("open-session");
    expect(reachOf({ line: "absent", presence: true })).toBe("open-session");
  });

  test("a line herdr holds without a session is no session", () => {
    expect(reachOf({ line: "connected", presence: false })).toBe("no-session");
    expect(reachOf({ line: "unreachable", presence: false })).toBe("no-session");
  });
});
