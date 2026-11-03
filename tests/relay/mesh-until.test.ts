import { describe, expect, test } from "bun:test";
import { untilHolds } from "./support/mesh/mesh.ts";

/** A wake source that never fires, like hc when a machine's line changes state. */
const silent = (): (() => void) => () => {};

describe("until", () => {
  test("a condition that becomes true with no wake still resolves, by re-reading it", async () => {
    let reads = 0;
    await untilHolds(silent, "the third read", () => ++reads === 3, 2_000, 1);
    expect(reads).toBe(3);
  });

  test("a wake re-evaluates at once, without waiting for the next re-read", async () => {
    const wakes = new Set<() => void>();
    let holds = false;
    const waiting = untilHolds(
      (wake) => {
        wakes.add(wake);
        return () => wakes.delete(wake);
      },
      "the woken condition",
      () => holds,
      2_000,
      600_000,
    );
    holds = true;
    for (const wake of wakes) wake();
    await waiting;
    expect(wakes.size).toBe(0);
  });
});
