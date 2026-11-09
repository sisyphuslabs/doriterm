import { describe, expect, test } from "bun:test";
import type { Terminal } from "@doriface/protocol";
import { latestPress, waitsOnKeys } from "./waiting-keys.ts";

type Status = NonNullable<Terminal["status"]>;

const terminal = (fields: Partial<Terminal>): Terminal =>
  ({ address: "t1", argv: ["sh"], labels: {}, state: "live", ...fields }) as Terminal;

describe("the keys a waiting agent is answered with (#1527)", () => {
  test("a live agent blocked with no card up is answered by keys", () => {
    expect(waitsOnKeys(terminal({ status: { state: "blocked", app: "demo-agent" } as Status }), "none")).toBe(true);
    expect(waitsOnKeys(terminal({ status: { state: "blocked" } as Status }), "none")).toBe(true);
  });

  test("a Claude Code or Codex agent that draws no card gets the keys too (#1555)", () => {
    const claude = terminal({ status: { state: "blocked", kind: "permission", app: "claude-code" } as Status });
    const codex = terminal({ status: { state: "blocked", app: "codex" } as Status });
    expect(waitsOnKeys(claude, "none")).toBe(true);
    expect(waitsOnKeys(codex, "none")).toBe(true);
  });

  test("no keys while a card is up, or while its screen is still being read for one", () => {
    const blocked = terminal({ status: { state: "blocked", kind: "permission", app: "claude-code" } as Status });
    expect(waitsOnKeys(blocked, "shown")).toBe(false);
    expect(waitsOnKeys(blocked, "reading")).toBe(false);
  });

  test("an agent at work, idle, or a terminal that ended is not waiting", () => {
    expect(waitsOnKeys(terminal({ status: { state: "working", app: "demo-agent" } as Status }), "none")).toBe(false);
    expect(waitsOnKeys(terminal({}), "none")).toBe(false);
    expect(
      waitsOnKeys(
        terminal({ state: "ended", status: { state: "blocked", app: "demo-agent" } } as Partial<Terminal>),
        "none",
      ),
    ).toBe(false);
  });
});

/** A press whose call is settled by hand, and the failure flags the tracker reported, in order. */
function harness() {
  const reported: boolean[] = [];
  const press = latestPress((failed) => reported.push(failed));
  const settle: { ok: () => void; fail: () => void }[] = [];
  const calls: Promise<void>[] = [];
  const send = () => {
    const call = Promise.withResolvers<void>();
    settle.push({ ok: () => call.resolve(), fail: () => call.reject(new Error("dropped")) });
    calls.push(call.promise);
    press(() => call.promise);
  };
  /** Every call so far has settled and the tracker has seen each outcome (its handlers were attached first). */
  const settled = () => Promise.allSettled(calls);
  return { reported, send, settle, settled };
}

describe("the strip's failure line follows the latest press only (#1555)", () => {
  test("a press that fails after a later one went through leaves no failure showing", async () => {
    const { reported, send, settle, settled } = harness();
    send();
    send();
    settle[1]?.ok();
    settle[0]?.fail();
    await settled();
    expect(reported).toEqual([false, false]);
  });

  test("the latest press failing says so, and the next press clears it", async () => {
    const { reported, send, settle, settled } = harness();
    send();
    settle[0]?.fail();
    await settled();
    expect(reported).toEqual([false, true]);
    send();
    expect(reported).toEqual([false, true, false]);
  });
});
