import { describe, expect, test } from "bun:test";
import { readScreenPrompt } from "./approval-screen.ts";
import type { Terminal } from "./__generated__/hc-api.ts";
import {
  MAX_NOTICE_BODY,
  MAX_NOTICE_TITLE,
  type NoticeContext,
  noticeContextOf,
  noticeText,
  parseNoticeContext,
} from "./notice-text.ts";
import { CLAUDE_BASH_311_SCREEN, CLAUDE_QUESTION_SCREEN } from "./testing/prompt-screens.ts";

const WHERE: NoticeContext = {
  machine: "build-box",
  space: "api-server",
  terminal: "migrations",
  agent: "claude-code",
};
const CONTEXT: NoticeContext = { ...WHERE, ask: "Apply the migration to the staging database?" };

const terminal = (fields: Partial<Terminal> = {}): Terminal => ({
  address: "t3",
  argv: ["claude"],
  cols: 80,
  rows: 24,
  created_ms: 1,
  cwd: "/home/q/src/api-server",
  labels: {},
  screen: "exact",
  state: "live",
  status: { state: "blocked", kind: "question", app: "claude-code" },
  ...fields,
});

describe("a notification's text (#1908)", () => {
  test("names the agent and its machine in the title, and where it runs and what it waits on in the body", () => {
    expect(noticeText("input", CONTEXT)).toEqual({
      title: "claude-code@build-box",
      body: "api-server · migrations — Waiting for your input\n“Apply the migration to the staging database?”",
    });
    expect(noticeText("permission", { ...CONTEXT, ask: "wants to run: rm -rf build" }).body).toBe(
      "api-server · migrations — Asking for permission\n“wants to run: rm -rf build”",
    );
    expect(noticeText("done", { machine: "build-box", agent: "codex", space: "web" })).toEqual({
      title: "codex@build-box",
      body: "web — Finished its turn",
    });
  });

  test("without anything the host named, it is today's fixed sentence: the honest fallback", () => {
    expect(noticeText("input")).toEqual({ title: "Doriterm", body: "An agent is waiting for your input." });
    expect(noticeText("permission", {})).toEqual({ title: "Doriterm", body: "An agent is asking for permission." });
  });

  test("a session title the agent set is shown when it says more than the terminal's name", () => {
    expect(noticeText("input", { ...WHERE, session: "Fix the flaky login test" }).body).toBe(
      "api-server · migrations · Fix the flaky login test — Waiting for your input",
    );
    expect(noticeText("input", { ...WHERE, session: "migrations" }).body).toBe(
      "api-server · migrations — Waiting for your input",
    );
  });

  test("stays inside the platforms' limits, whole characters, with an ellipsis where it was cut", () => {
    const long = { ...CONTEXT, agent: "a".repeat(200), machine: "m".repeat(200), ask: "🙂".repeat(400) };
    const { title, body } = noticeText("input", long);
    expect([...title].length).toBeLessThanOrEqual(MAX_NOTICE_TITLE);
    expect([...body].length).toBeLessThanOrEqual(MAX_NOTICE_BODY);
    expect(title.endsWith("…")).toBe(true);
    expect(body.endsWith("…”")).toBe(true);
    expect(body).not.toContain("\uFFFD");
  });

  test("an agent's control characters and direction overrides never reach the OS", () => {
    const { title, body } = noticeText("input", {
      ...CONTEXT,
      agent: "claude\u0007\u202Eedoc",
      ask: "line one\nline\ttwo\u001B[31m",
    });
    expect(title).toBe("claudeedoc@build-box");
    expect(body.split("\n")[1]).toBe("“line one line two[31m”");
  });
});

describe("what the host names about a terminal (#1908)", () => {
  test("a question: its agent, machine, space, terminal and the question itself", () => {
    const prompt = readScreenPrompt("claude-code", CLAUDE_QUESTION_SCREEN);
    expect(noticeContextOf(terminal({ labels: { "herdr.name": "migrations" } }), "build-box", prompt)).toEqual({
      machine: "build-box",
      space: "api-server",
      terminal: "migrations",
      agent: "claude-code",
      ask: "Which database should the migration target?",
    });
  });

  test("a permission says what the agent wants to do", () => {
    const prompt = readScreenPrompt("claude-code", CLAUDE_BASH_311_SCREEN);
    expect(noticeContextOf(terminal({ labels: { space: "infra" } }), "box", prompt)).toMatchObject({
      space: "infra",
      ask: "wants to run: touch probe-a.txt",
    });
  });

  test("with no prompt, the agent's own status words and session title", () => {
    const done = terminal({
      name: "review",
      status: { state: "done", app: "codex", msg: "All tests pass", title: "PR 12" },
    });
    expect(noticeContextOf(done, "box")).toEqual({
      machine: "box",
      space: "api-server",
      terminal: "review",
      agent: "codex",
      session: "PR 12",
      ask: "All tests pass",
    });
  });

  test("a name the app gave only to open the terminal is no name", () => {
    expect(noticeContextOf(terminal({ name: "opened-a1b2c3", title: "zsh" }), "box").terminal).toBe("zsh");
  });
});

describe("a context read off the push stream (#1908)", () => {
  test("keeps only known string members, cleaned and bounded", () => {
    expect(parseNoticeContext({ machine: "box", agent: "x".repeat(500), ask: 7, extra: "dropped", space: "" })).toEqual(
      { machine: "box", agent: `${"x".repeat(63)}…` },
    );
  });

  test("anything but an object, or an object naming nothing, is no context", () => {
    expect(parseNoticeContext("box")).toBeUndefined();
    expect(parseNoticeContext(null)).toBeUndefined();
    expect(parseNoticeContext({ ask: 3 })).toBeUndefined();
  });
});
