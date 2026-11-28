import type { StreamClose } from "@doriface/client";
import { describe, expect, test } from "bun:test";
import { closesTab, type TerminalEnd, terminalEnd } from "./terminal-end.ts";

const NO_EXIT = { exit_code: null, signal: null, finished_ms: null } as const;

// The CLOSE payloads hc 0.1.17 sends, as measured against a real core.
const CLOSES: readonly [string, StreamClose, TerminalEnd, boolean][] = [
  ["exit 3", { by: "core", reason: "exited", exit_code: 3, signal: null, finished_ms: 1 }, "finished", true],
  ["kill -9, not kept", { by: "core", reason: "exited", exit_code: null, signal: 9, finished_ms: 1 }, "finished", true],
  ["kill -9, kept", { by: "core", reason: "signaled", exit_code: null, signal: 9, finished_ms: null }, "lost", false],
  ["empty core CLOSE", { by: "core", reason: "closed", ...NO_EXIT }, "lost", false],
  ["viewer detach", { by: "viewer", reason: "detached", ...NO_EXIT }, "detached", false],
  ["connection drop", { by: "connection", reason: "connection_closed", ...NO_EXIT }, "dropped", false],
];

describe("terminalEnd", () => {
  test.each(CLOSES)(
    "%s ends as the right TerminalEnd and closes its tab only when finished",
    (_, close, end, closes) => {
      expect(terminalEnd(close)).toBe(end);
      expect(closesTab(terminalEnd(close))).toBe(closes);
    },
  );

  test("the person's close of a view that said its program ended closes its tab (#2986)", () => {
    expect(closesTab("closed")).toBe(true);
  });
});
