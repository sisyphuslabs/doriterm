import { describe, expect, test } from "bun:test";
import { firstAnswer } from "./first-answer.ts";
import type { MemberConnection } from "./mesh-connections.ts";

const store = (phase: "open" | "connecting" | "failed"): MemberConnection =>
  ({
    state:
      phase === "failed"
        ? { phase, error: new Error("down"), retryInMs: 1_000, retryAt: 0, stale: null }
        : phase === "open"
          ? { phase, connection: undefined, path: "relay" }
          : { phase, attempt: 0, stale: null },
  }) as unknown as MemberConnection;

describe("a start goes through the first member that answers (#2531)", () => {
  test("while the saved host is still dialing, a member that already answered carries the workspace", () => {
    const saved = store("connecting");
    const stores = new Map([
      ["a", saved],
      ["b", store("open")],
    ]);
    expect(firstAnswer(stores, saved, () => false, false)).toBe("b");
  });

  test("once the shown member was reached this session, a redial of it does not move the route", () => {
    const saved = store("connecting");
    const stores = new Map([
      ["a", saved],
      ["b", store("open")],
    ]);
    expect(firstAnswer(stores, saved, (id) => id === "a", false)).toBeUndefined();
  });

  test("an address that names a place on the shown machine keeps it, however long it dials (#2532)", () => {
    const saved = store("connecting");
    const stores = new Map([
      ["a", saved],
      ["b", store("open")],
    ]);
    expect(firstAnswer(stores, saved, () => false, true)).toBeUndefined();
  });

  test("with no other member open yet there is nothing to go through", () => {
    const saved = store("connecting");
    const stores = new Map([
      ["a", saved],
      ["b", store("connecting")],
    ]);
    expect(firstAnswer(stores, saved, () => false, false)).toBeUndefined();
  });
});
