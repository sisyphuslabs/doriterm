import { expect, test } from "bun:test";
import type { MemberEntry } from "../connection/mesh-connections.ts";
import { onlineCount } from "./membership-device.tsx";

type OpenState = Extract<MemberEntry["state"], { readonly phase: "open" }>;

const openMember = (hostId: string, resuming: boolean): MemberEntry => ({
  target: { hostId, hostName: hostId, hostKey: "", directUrl: "" },
  state: { phase: "open", connection: {} as OpenState["connection"], path: "relay", resuming },
});

const offline: MemberEntry = {
  target: { hostId: "c", hostName: "c", hostKey: "", directUrl: "" },
  state: { phase: "failed", error: new Error("offline"), retryInMs: 1_000, retryAt: 0, stale: null },
};

test("a machine whose session is being carried on is not counted as online (#2424)", () => {
  expect(onlineCount([openMember("a", false), openMember("b", true), offline])).toBe(1);
  expect(onlineCount([openMember("a", false), openMember("b", false), offline])).toBe(2);
});
