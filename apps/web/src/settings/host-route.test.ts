import { describe, expect, test } from "bun:test";
import { installShellForwarder } from "../connection/direct-forward.test-support.ts";
import { hostRouteOf } from "./host-route.ts";

const base = {
  hostId: "",
  mode: "relay" as const,
  relayUrl: "wss://relay.example.dev",
  directUrl: "",
  loopbackUrl: "ws://127.0.0.1:7766/v1/hc",
};

describe("how this app reaches its host", () => {
  test("a paired host over the relay names the relay, and that the session is encrypted", () => {
    expect(hostRouteOf({ ...base, hostId: "a-paired-host" })).toEqual({
      route: "relay",
      address: "relay.example.dev",
      label: "Through the relay relay.example.dev · end-to-end encrypted",
    });
  });

  test("a known direct address is named beside the relay, never claimed for it, where the direct path is on (#446)", () => {
    const route = hostRouteOf({ ...base, hostId: "a-paired-host", directUrl: "https://192.0.2.10:7766" }, true);
    expect(route.route).toBe("relay");
    expect(route.label).toContain("or direct to 192.0.2.10:7766 when it answers");
    expect(route.label).toContain("end-to-end encrypted");
  });

  test("the desktop shell names only the relay while the direct path is off, whatever address the file holds (#2070)", () => {
    const shell = installShellForwarder();
    try {
      expect(hostRouteOf({ ...base, hostId: "a-paired-host", directUrl: "https://192.0.2.10:7766" })).toEqual({
        route: "relay",
        address: "relay.example.dev",
        label: "Through the relay relay.example.dev · end-to-end encrypted",
      });
    } finally {
      shell.restore();
    }
  });

  test("a browser names only the relay, whatever direct address a file left behind (#1381 §8)", () => {
    const route = hostRouteOf({ ...base, hostId: "a-paired-host", directUrl: "https://192.0.2.10:7766" });
    expect(route).toEqual({
      route: "relay",
      address: "relay.example.dev",
      label: "Through the relay relay.example.dev · end-to-end encrypted",
    });
  });

  test("the loopback gateway says plain text, and says it is for development", () => {
    expect(hostRouteOf({ ...base, mode: "loopback" })).toEqual({
      route: "loopback",
      address: "127.0.0.1:7766",
      label: "Loopback 127.0.0.1:7766 · plain text, for development",
    });
  });

  test("a malformed address is shown as it was saved, never as an empty label", () => {
    expect(hostRouteOf({ ...base, hostId: "a-paired-host", relayUrl: "not a url" }).address).toBe("not a url");
  });

  test("an app with no host paired gets no route label, so it cannot claim a relay it is not using", () => {
    expect(hostRouteOf({ ...base, hostId: "" }).label).toBeUndefined();
  });
});
