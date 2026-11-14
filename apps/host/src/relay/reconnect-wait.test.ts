import { describe, expect, test } from "bun:test";
import { reconnectWait } from "./host-uplink.ts";

describe("how the host log states the wait before a redial (#2498)", () => {
  test.each([
    [0, "reconnecting now"],
    [180, "reconnecting in 180 ms"],
    [999, "reconnecting in 999 ms"],
    [1_000, "reconnecting in 1 s"],
    [1_400, "reconnecting in 2 s"],
    [30_000, "reconnecting in 30 s"],
  ])("%p ms reads %p", (ms, line) => {
    expect(reconnectWait(ms)).toBe(line);
  });
});
