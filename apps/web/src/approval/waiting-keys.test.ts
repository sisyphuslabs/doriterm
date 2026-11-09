import { describe, expect, test } from "bun:test";
import type { Terminal } from "@doriface/protocol";
import { waitsOnKeys } from "./waiting-keys.ts";

type Status = NonNullable<Terminal["status"]>;

const terminal = (fields: Partial<Terminal>): Terminal =>
  ({ address: "t1", argv: ["sh"], labels: {}, state: "live", ...fields }) as Terminal;

describe("the keys a waiting agent is answered with (#1527)", () => {
  test("a live agent blocked with no prompt card of its own is answered by keys", () => {
    expect(waitsOnKeys(terminal({ status: { state: "blocked", app: "demo-agent" } as Status }))).toBe(true);
    expect(waitsOnKeys(terminal({ status: { state: "blocked" } as Status }))).toBe(true);
  });

  test("an agent whose prompts get a card keeps the card", () => {
    expect(waitsOnKeys(terminal({ status: { state: "blocked", app: "claude-code" } as Status }))).toBe(false);
    expect(waitsOnKeys(terminal({ status: { state: "blocked", app: "codex" } as Status }))).toBe(false);
  });

  test("an agent at work, idle, or a terminal that ended is not waiting", () => {
    expect(waitsOnKeys(terminal({ status: { state: "working", app: "demo-agent" } as Status }))).toBe(false);
    expect(waitsOnKeys(terminal({}))).toBe(false);
    expect(
      waitsOnKeys(terminal({ state: "ended", status: { state: "blocked", app: "demo-agent" } } as Partial<Terminal>)),
    ).toBe(false);
  });
});
