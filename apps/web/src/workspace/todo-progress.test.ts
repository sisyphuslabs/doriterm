import type { Terminal } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { holdsTodoRead, todoReadKey } from "./todo-progress.ts";

const terminal = (status: Terminal["status"], extra: Partial<Terminal> = {}): Terminal => ({
  address: "t1",
  argv: ["claude"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work",
  labels: {},
  screen: "exact",
  state: "live",
  ...(status === undefined ? {} : { reported: true, status }),
  ...extra,
});

describe("todoReadKey", () => {
  test("a live Claude Code terminal is read, and read again when its status moves", () => {
    const first = todoReadKey(terminal({ app: "claude-code", state: "working", progress: 25 }));
    const next = todoReadKey(terminal({ app: "claude-code", state: "working", progress: 50 }));
    expect(first).toBeDefined();
    expect(next).toBeDefined();
    expect(next).not.toBe(first);
    expect(todoReadKey(terminal({ app: "claude-code", state: "working", progress: 25 }))).toBe(first);
  });

  test("a new turn or a new status time is a reason to read too", () => {
    const base = terminal({ app: "claude-code", state: "idle" }, { turn: 1, status_ms: 10 });
    expect(todoReadKey(terminal({ app: "claude-code", state: "idle" }, { turn: 2, status_ms: 10 }))).not.toBe(
      todoReadKey(base),
    );
    expect(todoReadKey(terminal({ app: "claude-code", state: "idle" }, { turn: 1, status_ms: 20 }))).not.toBe(
      todoReadKey(base),
    );
  });

  test("an agent with no reader, a program that never reported, an ended or offline terminal: never read", () => {
    expect(todoReadKey(terminal({ app: "codex", state: "working" }))).toBeUndefined();
    expect(todoReadKey(terminal(undefined))).toBeUndefined();
    expect(todoReadKey(terminal({ app: "claude-code", state: "done" }, { state: "finished" }))).toBeUndefined();
    expect(todoReadKey({ ...terminal({ app: "claude-code", state: "working" }), offline: true })).toBeUndefined();
  });

  test("a blocked agent holds: the approval card reads its screen, and its list cannot move while it waits", () => {
    expect(holdsTodoRead(terminal({ app: "claude-code", state: "blocked", kind: "permission" }))).toBe(true);
    expect(holdsTodoRead(terminal({ app: "claude-code", state: "working" }))).toBe(false);
  });
});
