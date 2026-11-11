import { describe, expect, test } from "bun:test";
import { neighbour, shouldSelect } from "./use-app-actions.ts";

describe("neighbour", () => {
  test("steps through the list and wraps", () => {
    expect(neighbour(["t1", "t2", "t3"], "t3", 1)).toBe("t1");
    expect(neighbour(["t1", "t2", "t3"], "t1", -1)).toBe("t3");
  });

  test("is null when the only target is the current one, so the key is not swallowed", () => {
    expect(neighbour(["t1"], "t1", 1)).toBeNull();
    expect(neighbour([], null, 1)).toBeNull();
  });
});

describe("shouldSelect", () => {
  test("selecting the tab already active is not an action, so the key reaches the terminal", () => {
    expect(shouldSelect("t1", "t1")).toBe(false);
    expect(shouldSelect(null, "t1")).toBe(false);
    expect(shouldSelect("t2", "t1")).toBe(true);
    expect(shouldSelect("t1", null)).toBe(true);
  });

  test("a false answer does not claim the address is null", () => {
    const address: string | null = ["t1"][0] ?? null;
    if (!shouldSelect(address, "t1")) expect(address?.length).toBe(2);
  });
});
