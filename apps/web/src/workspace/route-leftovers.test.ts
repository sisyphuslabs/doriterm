import { expect, test } from "bun:test";
import { fromPerHost } from "../layout/view.ts";
import { rekeyPlaceHref } from "./phone-place.ts";

test("a phone history entry made through core c reads back as the same space and terminal through core m (#2588)", () => {
  expect(rekeyPlaceHref("/?s=space:s1&t=local:t7", "c", "m")).toBe("/?s=space:c/s1&t=id:c/t7");
  expect(rekeyPlaceHref("/?s=space:m/s2&t=id:m/t3", "c", "m")).toBe("/?s=space:s2&t=local:t3");
});

test("a seen mark carried over from core c's old view is kept by id with c's machine names (#2588)", () => {
  const view = { active: null, focused: {}, zoomed: {}, spaces: {}, seen: { "box/t2": "5", t1: "4" } };
  const ids = { byName: new Map([["box", "b-id"]]), byId: new Map([["b-id", "box"]]) };
  expect(fromPerHost(view, "c", ids).seen).toEqual({ "@b-id/t2": "5", "@c/t1": "4" });
});
