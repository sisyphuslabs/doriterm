import { describe, expect, test } from "bun:test";
import { PHONE_LIST, phoneHref, phoneOpenKey, phoneParent, phoneRoute, rememberOpenKey } from "./phone-route.ts";

describe("the phone's place, read from and written to the list's address", () => {
  test("a space screen and a terminal opened from it round-trip through the address", () => {
    const route = { space: "space:local/spc web", terminal: "local/tb-1" };
    const href = phoneHref(route);
    expect(href).toBe("/?s=space%3Alocal%2Fspc%20web&t=local%2Ftb-1");
    const search = Object.fromEntries(new URL(href, "http://phone").searchParams);
    expect(phoneRoute(search)).toEqual(route);
  });

  test("the bare list is /, and a param that is empty or not text names nothing", () => {
    expect(phoneHref(PHONE_LIST)).toBe("/");
    expect(phoneRoute({ s: "", t: 7 })).toEqual(PHONE_LIST);
    expect(phoneRoute({})).toEqual(PHONE_LIST);
  });

  test("Back closes a terminal to the screen it came from, and a space to the list", () => {
    expect(phoneParent({ space: "s1", terminal: "t1" })).toEqual({ space: "s1", terminal: null });
    expect(phoneParent({ space: null, terminal: "t1" })).toEqual(PHONE_LIST);
    expect(phoneParent({ space: "s1", terminal: null })).toEqual(PHONE_LIST);
  });
});

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
    // The list with no ?t= closed the terminal (Back): nothing is remembered, so a later Settings opens none (review of #1078).
    expect(rememberOpenKey("/", null, "machine-c")).toBeNull();
    expect(rememberOpenKey("/settings", null, "machine-c")).toBe("machine-c");
    expect(rememberOpenKey("/settings", "machine-e", "machine-c")).toBe("machine-e");
  });
});
