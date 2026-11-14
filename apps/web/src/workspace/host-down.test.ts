import { expect, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import type { ConnectionState } from "../connection/store.ts";
import { HOST_DOWN_GRACE_MS, hostDownWhy, linkDown } from "./host-down.ts";

const stale = {} as HcConnection;
const refused = Object.assign(new Error("closed"), { code: 4404 });
const failed: ConnectionState = {
  phase: "failed",
  error: refused,
  retryInMs: 5_000,
  retryAt: 0,
  stale,
};
const CANNOT_REACH =
  "Your host isn't connected right now. Check that its computer is awake and doriface-host is running.";

test("a host that stays down past the grace says why in the words Settings uses (#2464, #2426)", () => {
  expect(hostDownWhy(failed, HOST_DOWN_GRACE_MS)).toBe(CANNOT_REACH);
  const resuming: ConnectionState = {
    phase: "open",
    connection: stale,
    path: "relay",
    resuming: true,
    resumeFailure: refused,
  };
  expect(hostDownWhy(resuming, HOST_DOWN_GRACE_MS + 1)).toBe(CANNOT_REACH);
});

test("within the grace, or before any dial failed, a drop says only that it reconnects (#1686)", () => {
  expect(hostDownWhy(failed, HOST_DOWN_GRACE_MS - 1)).toBeNull();
  expect(hostDownWhy(failed, null)).toBeNull();
  const resuming: ConnectionState = { phase: "open", connection: stale, path: "relay", resuming: true };
  expect(hostDownWhy(resuming, HOST_DOWN_GRACE_MS * 2)).toBeNull();
});

test("the grace counts from the drop of a workspace still on screen, not from a first connect", () => {
  expect(linkDown(failed)).toBe(true);
  expect(linkDown({ ...failed, stale: null })).toBe(false);
  expect(linkDown({ phase: "connecting", attempt: 0, stale: null })).toBe(false);
  expect(linkDown({ phase: "open", connection: stale, path: "relay" })).toBe(false);
});
