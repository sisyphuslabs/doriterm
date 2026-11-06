import { expect, test } from "bun:test";
import { sentBy } from "./use-sticky-keys.ts";

const latched = (...ids: string[]): ReadonlySet<string> => new Set(ids);

test("with nothing latched a key sends exactly the bytes it carries", () => {
  for (const bytes of ["\u0003", "echo hi", "\u001b[A", "chmod +x"]) {
    expect(sentBy(bytes, latched(), "other")).toEqual({ kind: "write", data: bytes });
  }
});

test("a latched modifier is applied to the key and then let go", () => {
  expect(sentBy("c", latched("ctrl"), "other")).toEqual({ kind: "write", data: "\u0003" });
  expect(sentBy("\u001b[A", latched("ctrl"), "other")).toEqual({ kind: "write", data: "\u001b[1;5A" });
  expect(sentBy("echo hi", latched("alt"), "other")).toEqual({ kind: "write", data: "\u001becho hi" });
});

test("the paste chord pastes instead of writing", () => {
  expect(sentBy("v", latched("cmd"), "mac")).toEqual({ kind: "paste" });
  expect(sentBy("v", latched("ctrl", "shift"), "other")).toEqual({ kind: "paste" });
});
