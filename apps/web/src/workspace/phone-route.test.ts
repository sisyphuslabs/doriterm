import { describe, expect, test } from "bun:test";
import { entersFromList, phoneOpenKey, rememberOpenKey } from "./phone-route.ts";

describe("the phone's open terminal, read from the route", () => {
  test("the list shows what ?t= names, and nothing when it names nothing", () => {
    expect(phoneOpenKey("/", "machine-a", null)).toBe("machine-a");
    expect(phoneOpenKey("/", null, "machine-a")).toBeNull();
  });

  // #976: Settings is mounted over the same workspace, so reading it as "nothing is open" unmounted the terminal there
  // and reattached it on the way back.
  test("a route that is not the list keeps the last terminal open", () => {
    expect(phoneOpenKey("/settings", null, "machine-a")).toBe("machine-a");
    expect(phoneOpenKey("/pair", null, "machine-b")).toBe("machine-b");
    expect(phoneOpenKey("/settings", null, null)).toBeNull();
  });

  test("only the list changes what is remembered", () => {
    expect(rememberOpenKey("/", "machine-c", null)).toBe("machine-c");
    expect(rememberOpenKey("/", null, "machine-c")).toBe("machine-c");
    expect(rememberOpenKey("/settings", null, "machine-c")).toBe("machine-c");
    expect(rememberOpenKey("/settings", "ignored", "machine-c")).toBe("machine-c");
  });
});

describe("what counts as entering a terminal", () => {
  test("the list adds an entry, a switch does not", () => {
    expect(entersFromList(null)).toBe(true);
    expect(entersFromList("machine-a")).toBe(false);
  });
});
