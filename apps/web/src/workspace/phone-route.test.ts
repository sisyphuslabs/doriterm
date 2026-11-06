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

  // A link that names the terminal keeps it open on any route, which is what a deep link to Settings carries.
  test("a route that names a terminal keeps that terminal", () => {
    expect(phoneOpenKey("/settings", "machine-d", null)).toBe("machine-d");
    expect(phoneOpenKey("/settings", "machine-d", "machine-c")).toBe("machine-d");
  });

  test("what is remembered follows the route, and survives one that says nothing", () => {
    expect(rememberOpenKey("/", "machine-c", null)).toBe("machine-c");
    expect(rememberOpenKey("/", null, "machine-c")).toBe("machine-c");
    expect(rememberOpenKey("/settings", null, "machine-c")).toBe("machine-c");
    expect(rememberOpenKey("/settings", "machine-e", "machine-c")).toBe("machine-e");
  });
});

describe("what counts as entering a terminal", () => {
  test("the list adds an entry, a switch does not", () => {
    expect(entersFromList(null)).toBe(true);
    expect(entersFromList("machine-a")).toBe(false);
  });
});
