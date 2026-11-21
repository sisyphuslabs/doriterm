import { describe, expect, test } from "bun:test";
import { DEFAULT_PUSH_PREFS, noticeMachineId } from "@doriface/protocol";
import { wanted } from "./notice-trigger.ts";

// #2567: core A lists core B as "box". A mute is a choice about machine B, so it holds whichever host the page goes through.
describe("a notification mute is the machine's, not the route's (#2567)", () => {
  // Settings > Notifications, going through A: B is "box", so its switch writes the key A's name for B gives.
  const mutedThroughA = { ...DEFAULT_PUSH_PREFS, muted: [noticeMachineId("box")] };

  test("going through A, B's agents are muted", () => {
    expect(wanted({ terminal: "box/t1", machine: "box", kind: "done" }, mutedThroughA, null)).toBe(false);
  });

  test("going through B, B's own agents are still muted", () => {
    // Through B, B's terminals are B's core's own: bare addresses, no machine.
    expect(wanted({ terminal: "t1", machine: undefined, kind: "done" }, mutedThroughA, null)).toBe(false);
  });

  test("going through B, A's agents are still heard", () => {
    expect(wanted({ terminal: "studio/t1", machine: "studio", kind: "done" }, mutedThroughA, null)).toBe(true);
  });
});
