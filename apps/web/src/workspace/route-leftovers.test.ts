import { expect, test } from "bun:test";
import { fromPerHost } from "../layout/view.ts";
import { rekeyPlaceHref } from "./phone-place.ts";
import { phoneHref } from "./phone-route.ts";

const href = (space: string | null, terminal: string | null): string =>
  phoneHref({ section: "agents", space, terminal, sheet: false });

test("a phone history entry made through core c reads back as the same space and terminal through core m (#2588)", () => {
  expect(rekeyPlaceHref(href("space:s1", "local:t7"), "c", "m")).toBe(href("space:c/s1", "id:c/t7"));
  expect(rekeyPlaceHref(href("space:m/s2", "id:m/t3"), "c", "m")).toBe(href("space:s2", "local:t3"));
  expect(rekeyPlaceHref(href("space:s1", null), "c", "c")).toBe(href("space:s1", null));
});

test("a seen mark carried over from another core's old view is kept by id for that core's own terminals and dropped when it names a machine by that core's name (#2588)", () => {
  const view = { active: null, focused: {}, zoomed: {}, spaces: {}, seen: { "box/t2": "5", t1: "4" } };
  expect(fromPerHost(view, "c").seen).toEqual({ "@c/t1": "4" });
});
