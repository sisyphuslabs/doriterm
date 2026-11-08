import { describe, expect, test } from "bun:test";
import { showsConnected } from "./reconnect-status.tsx";

const offline = { label: "Offline", detail: "Offline. Reconnects when the network is back.", offline: true };
const reconnecting = { label: "Reconnecting in 3 s", detail: "Reconnecting in 3 s", offline: false };

describe("Connected is the healthy session's baseline (#1456)", () => {
  test.each([
    ["open, nothing wrong", "open", null, true],
    ["open, but the device is offline", "open", offline, false],
    ["open, but reconnecting", "open", reconnecting, false],
    ["failed", "failed", reconnecting, false],
    ["not set up", "unconfigured", null, false],
  ] as const)("%s", (_name, phase, notice, shown) => {
    expect(showsConnected(phase, notice)).toBe(shown);
  });
});
