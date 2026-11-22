import { describe, expect, test } from "bun:test";
import { reconnectingLabel, reconnectingTo } from "./reconnect-status.tsx";

const member = (hostName: string) => ({ hostId: hostName, hostName, hostKey: "", directUrl: "" });

describe("the reconnect notice names the machine it waits for (#2464 review)", () => {
  test("a paired member of several is said by name, with and without a countdown", () => {
    const settings = { hostName: "studio", members: [member("studio"), member("laptop")] };
    expect(reconnectingTo(settings)).toBe("studio");
    expect(reconnectingLabel(reconnectingTo(settings), null)).toBe("Reconnecting to studio…");
    expect(reconnectingLabel(reconnectingTo(settings), 4)).toBe("Reconnecting to studio in 4 s");
  });

  test("the only host is not named: there is no other to tell it from", () => {
    const settings = { hostName: "studio", members: [member("studio")] };
    expect(reconnectingLabel(reconnectingTo(settings), 5)).toBe("Reconnecting in 5 s");
    expect(reconnectingLabel(reconnectingTo({ hostName: "", members: [] }), null)).toBe("Reconnecting…");
  });

  test("a member that has not said its name yet reads without one", () => {
    const settings = { hostName: "", members: [member(""), member("laptop")] };
    expect(reconnectingLabel(reconnectingTo(settings), 2)).toBe("Reconnecting in 2 s");
  });
});
