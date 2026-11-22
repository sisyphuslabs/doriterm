import { describe, expect, test } from "bun:test";
import type { Terminal } from "@doriface/protocol";
import { terminal } from "./fake-core.test-support.ts";
import { sameShape, type TerminalsState } from "./terminals-state.ts";

const state = (terminals: readonly Terminal[], fields: Partial<TerminalsState> = {}): TerminalsState => ({
  terminals,
  loaded: true,
  machines: 0,
  error: null,
  ...fields,
});

const shell = { pid: 7, name: "sh", argv: ["sh"], cwd: "/work/a" };
const one = terminal("t1", { title: "sh", foreground: shell });
const other = terminal("t2");

describe("sameShape: what a terminal shows is not its shape; what places or lists it is (#2607)", () => {
  test.each<[string, Partial<Terminal>]>([
    ["a new title", { title: "vim notes.md" }],
    [
      "another program in front, in the same directory",
      { foreground: { ...shell, pid: 8, name: "vim", argv: ["vim"] } },
    ],
  ])("%s keeps the shape", (_, change) => {
    expect(sameShape(state([one, other]), state([{ ...one, ...change }, other]))).toBe(true);
  });

  test.each<[string, Partial<Terminal>]>([
    ["the foreground moving to another directory, which places it in a space", { foreground: { ...shell, cwd: "/b" } }],
    ["the foreground going away", { foreground: null }],
    ["an agent's status", { status: { state: "working" } }],
    ["labels (a rename, a space, a pin)", { labels: { name: "api" } }],
    ["a restarted program's pid", { pid: 99 }],
    ["a resize", { cols: 120 }],
    ["the program ending", { state: "finished" }],
  ])("%s changes the shape", (_, change) => {
    expect(sameShape(state([one, other]), state([{ ...one, ...change }, other]))).toBe(false);
  });

  test("a foreground appearing where there was none changes the shape", () => {
    expect(sameShape(state([other]), state([{ ...other, foreground: shell }]))).toBe(false);
  });

  test("a terminal added, removed or moved in the list changes the shape", () => {
    expect(sameShape(state([one, other]), state([one]))).toBe(false);
    expect(sameShape(state([one, other]), state([other, one]))).toBe(false);
  });

  test("the list's own facts change the shape: loaded, the machine count, an error", () => {
    expect(sameShape(state([one]), state([one], { loaded: false }))).toBe(false);
    expect(sameShape(state([one]), state([one], { machines: 2 }))).toBe(false);
    expect(sameShape(state([one]), state([one], { error: "refused" }))).toBe(false);
  });
});
