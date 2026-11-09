import { expect, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import type { ConnectionState } from "../connection/store.ts";
import { memberRouteOf } from "./member-route.ts";

const connection = { hello: {} } as HcConnection;
const addresses = {
  relayUrl: "wss://relay.example.dev",
  directUrl: "https://192.0.2.10:7766",
  loopbackUrl: "ws://127.0.0.1:7700/v1/hc",
};

test("a direct session names its LAN address and that it is encrypted", () => {
  expect(memberRouteOf({ phase: "open", connection, path: "direct" }, addresses)).toEqual({
    path: "direct",
    line: "Direct to 192.0.2.10:7766 · end-to-end encrypted",
  });
});

test("a relayed session names the relay host and that it is encrypted", () => {
  expect(memberRouteOf({ phase: "open", connection, path: "relay" }, addresses)).toEqual({
    path: "relay",
    line: "Through the relay relay.example.dev · end-to-end encrypted",
  });
});

test("the loopback gateway says it is plain text", () => {
  expect(memberRouteOf({ phase: "open", connection, path: "loopback" }, addresses)?.line).toBe(
    "Loopback 127.0.0.1:7700 · plain text, for development",
  );
});

test("a direct session to a member with no saved address still names the route", () => {
  expect(memberRouteOf({ phase: "open", connection, path: "direct" }, { ...addresses, directUrl: "" })?.line).toBe(
    "Direct to its LAN address · end-to-end encrypted",
  );
});

test("a machine without an open session has no route to name", () => {
  const closed: readonly ConnectionState[] = [
    { phase: "unconfigured" },
    { phase: "connecting", attempt: 1, stale: null },
    { phase: "failed", error: new Error("offline"), retryInMs: 1_000, retryAt: 0, stale: null },
  ];
  for (const state of closed) expect(memberRouteOf(state, addresses)).toBeUndefined();
});
