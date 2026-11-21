import { expect, test } from "bun:test";
import { listKey, readsAgain } from "./use-omo-commands.ts";

test("OmO started again in another directory or as another program has a list of its own", () => {
  const first = listKey("box/1", "omo", "/work/a");
  expect(listKey("box/1", "omo", "/work/a")).toBe(first);
  expect(listKey("box/1", "omo", "/work/b")).not.toBe(first);
  expect(listKey("box/1", "/opt/omo", "/work/a")).not.toBe(first);
  expect(listKey("box/2", "omo", "/work/a")).not.toBe(first);
});

test("a wanted list is read when never read, failed, or past its lifetime, and not while it is being read", () => {
  const ready = { kind: "ready", commands: [], at: 1000 } as const;
  expect(readsAgain({ kind: "idle" }, 0, 500)).toBe(true);
  expect(readsAgain({ kind: "failed" }, 0, 500)).toBe(true);
  expect(readsAgain({ kind: "loading" }, 10_000, 500)).toBe(false);
  expect(readsAgain(ready, 1499, 500)).toBe(false);
  expect(readsAgain(ready, 1500, 500)).toBe(true);
});
