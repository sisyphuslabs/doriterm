import { describe, expect, test } from "bun:test";
import { neighbour, shouldSelect, takesTextSizeKey } from "./use-app-actions.ts";

describe("takesTextSizeKey", () => {
  test("a browser keeps the text-size keys for its own zoom; the workspace and Settings take them in their handler", () => {
    expect(takesTextSizeKey(false)).toBe(false);
  });

  test("the desktop window never zooms, so its fallback steps the text on every screen (#388)", () => {
    expect(takesTextSizeKey(true)).toBe(true);
  });
});

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
