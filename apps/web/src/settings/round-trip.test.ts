import { expect, test } from "bun:test";
import { linkFacts, measureRoundTrip } from "./round-trip.ts";

test("the round trip is the time the live call took, and no number when it failed (#787)", async () => {
  const clock = { at: 1_000 };
  const answering = {
    call: () => {
      clock.at += 42;
      return Promise.resolve({ machines: [] });
    },
  };
  expect(await measureRoundTrip(answering as never, () => clock.at)).toBe(42);
  const failing = { call: () => Promise.reject(new Error("closed")) };
  expect(await measureRoundTrip(failing as never, () => clock.at)).toBeUndefined();
});

test("the host row is given only the link facts that were measured, never 0 ms for a missing one (#637, #787)", () => {
  expect(linkFacts(340.4, 42)).toEqual([
    { kind: "connect", ms: 340 },
    { kind: "round-trip", ms: 42 },
  ]);
  expect(linkFacts(340, undefined)).toEqual([{ kind: "connect", ms: 340 }]);
  expect(linkFacts(undefined, undefined)).toEqual([]);
});
