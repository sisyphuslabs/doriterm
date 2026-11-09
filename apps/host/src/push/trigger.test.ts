import { describe, expect, test } from "bun:test";
import { statusEvent, terminal } from "../testing/push-rig.ts";
import { NoticeTrigger, REPEAT_MS } from "./trigger.ts";

const blocked = { state: "blocked", kind: "question" };

describe("which status changes are notices", () => {
  test.each([
    ["blocked on a question", { state: "blocked", kind: "question" }, "input"],
    ["blocked without a kind", { state: "blocked" }, "input"],
    ["blocked on a permission", { state: "blocked", kind: "permission" }, "permission"],
    ["done", { state: "done" }, "done"],
    ["error", { state: "error" }, "error"],
    ["working", { state: "working" }, undefined],
    ["idle", { state: "idle" }, undefined],
  ] as const)("a change into %s", (_, status, kind) => {
    const trigger = new NoticeTrigger();
    trigger.baseline([terminal("t1", { state: "working" })]);
    expect(trigger.event(statusEvent("t1", status), 0)?.kind).toBe(kind);
  });

  test("a snapshot announces nothing: a terminal already waiting at start stays quiet", () => {
    const trigger = new NoticeTrigger();
    trigger.baseline([terminal("t1", blocked)]);
    expect(trigger.event(statusEvent("t1", blocked), 0)).toBeUndefined();
  });

  test("an added machine's terminal is addressed machine/t and names its machine, with the status that raised it", () => {
    const trigger = new NoticeTrigger();
    expect(trigger.event(statusEvent("t4", { state: "done", msg: "Migration written" }, "box"), 0)).toEqual({
      terminal: "box/t4",
      machine: "box",
      kind: "done",
      status: { state: "done", msg: "Migration written" },
    });
  });

  test("one terminal flapping into the same state is one notice per window", () => {
    const trigger = new NoticeTrigger();
    const at = (ms: number, status: { state: string }) => trigger.event(statusEvent("t1", status), ms)?.kind;
    expect(at(0, { state: "done" })).toBe("done");
    expect(at(1, { state: "working" })).toBeUndefined();
    expect(at(2, { state: "done" })).toBeUndefined();
    expect(at(3, { state: "working" })).toBeUndefined();
    expect(at(REPEAT_MS + 3, { state: "done" })).toBe("done");
  });
});
