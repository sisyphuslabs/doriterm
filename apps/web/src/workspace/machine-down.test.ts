import { expect, test } from "bun:test";
import { machineDownWhy } from "./machine-down.tsx";
import { ACTION_GRACE_MS } from "./machine-grace.ts";

const refused = { name: "studio", state: "unreachable", why: "dial failed (4404)" } as const;

test("within the grace a dropped machine says nothing more than that it reconnects (#1686)", () => {
  expect(machineDownWhy(refused, ACTION_GRACE_MS - 1)).toBeNull();
  expect(machineDownWhy(refused, undefined)).toBeNull();
  expect(machineDownWhy(undefined, ACTION_GRACE_MS)).toBeNull();
});

test("past the grace it says why in the offline notice's words, also while hc is redialing (#2464 review)", () => {
  const why =
    "doriface-host isn't running on studio, or it lost its connection. Start it there. Doriterm keeps trying to reach it.";
  expect(machineDownWhy(refused, ACTION_GRACE_MS)).toBe(why);
  expect(machineDownWhy({ ...refused, state: "connecting" }, ACTION_GRACE_MS * 2)).toBe(why);
  expect(machineDownWhy({ name: "studio", state: "connecting" }, ACTION_GRACE_MS)).toBe(
    "studio isn't answering. Check that it's on and reachable from here. Doriterm keeps trying to reach it.",
  );
});
