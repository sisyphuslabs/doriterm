import { describe, expect, test } from "bun:test";
import type { Terminal } from "./__generated__/hc-api.ts";
import { readScreenPrompt } from "./approval-screen.ts";
import {
  ELLIPSIS,
  MAX_BODY_CHARS,
  MAX_NOTICE_TEXT,
  MAX_TITLE_CHARS,
  noticeContextOf,
  noticeText,
  parseNoticeContext,
  scrubNoticeText,
  truncateMiddle,
} from "./notice-context.ts";
import { parsePushHostLine, parsePushNotice } from "./push.ts";
import { CLAUDE_PROMPT_SCREEN } from "./testing/approval-screens.ts";
import { CLAUDE_QUESTION_SCREEN } from "./testing/prompt-screens.ts";

const terminal = (fields: Partial<Terminal> = {}): Terminal => ({
  address: "t7",
  argv: ["/opt/homebrew/bin/claude"],
  cols: 80,
  rows: 24,
  created_ms: 1,
  cwd: "/Users/me/work/api-server",
  labels: {},
  screen: "exact",
  state: "live",
  status: { state: "blocked", kind: "question", app: "claude-code" },
  ...fields,
});

describe("what a notice's context is taken from", () => {
  test("a renamed terminal is titled by its rename, before its name and its program's title", () => {
    const named = terminal({ labels: { "herdr.name": "roster sync" }, name: "api", title: "✳ Claude Code" });
    expect(noticeContextOf({ terminal: named }).title).toBe("roster sync");
    expect(noticeContextOf({ terminal: terminal({ name: "api", title: "✳ Claude Code" }) }).title).toBe("api");
    expect(noticeContextOf({ terminal: terminal({ title: "✳ Claude Code" }) }).title).toBe("✳ Claude Code");
  });

  test("a name the page gave for an attach is no title; a program falls back to its basename, never its path", () => {
    expect(noticeContextOf({ terminal: terminal({ name: "opened-1a2b3c", title: "Codex" }) }).title).toBe("Codex");
    expect(noticeContextOf({ terminal: terminal() }).title).toBe("claude");
    expect(noticeContextOf({ terminal: terminal({ argv: [] }) }).title).toBe("t7");
  });

  test("the space is its label, else the working directory's last segment, and the machine is as given", () => {
    const context = noticeContextOf({ terminal: terminal(), machine: "build-box" });
    expect(context.space).toBe("api-server");
    expect(context.machine).toBe("build-box");
    expect(noticeContextOf({ terminal: terminal({ labels: { space: "payments" } }) }).space).toBe("payments");
    expect(noticeContextOf({ terminal: terminal() }).machine).toBeUndefined();
  });

  test("a permission asks as a sentence in the agent's words; a question asks its own line", () => {
    const permission = readScreenPrompt("claude-code", CLAUDE_PROMPT_SCREEN);
    expect(noticeContextOf({ terminal: terminal(), prompt: permission }).asks).toBe(
      "Claude Code wants to run touch probe-a.txt",
    );
    const question = readScreenPrompt("claude-code", CLAUDE_QUESTION_SCREEN);
    expect(noticeContextOf({ terminal: terminal(), prompt: question }).asks).toBe(
      "Which database should the migration target?",
    );
  });

  test("without a prompt the status message speaks, then its title; without a terminal the event's status still does", () => {
    const said = terminal({ status: { state: "done", msg: "Migration written", title: "deploy" } });
    expect(noticeContextOf({ terminal: said }).asks).toBe("Migration written");
    const titled = terminal({ status: { state: "done", title: "deploy" } });
    expect(noticeContextOf({ terminal: titled }).asks).toBe("deploy");
    expect(noticeContextOf({ status: { state: "error", msg: "exit 1" }, machine: "box" })).toEqual({
      machine: "box",
      asks: "exit 1",
    });
    expect(noticeContextOf({})).toEqual({});
  });
});

describe("what never reaches a notification", () => {
  test("a home directory reads ~ on every platform", () => {
    expect(scrubNoticeText("edit /Users/yeongyu/work/notes.md")).toBe("edit ~/work/notes.md");
    expect(scrubNoticeText("edit /home/box/notes.md and /Users/me")).toBe("edit ~/notes.md and ~");
    expect(scrubNoticeText(String.raw`type C:\Users\me\notes.md`)).toBe(String.raw`type ~\notes.md`);
  });

  test("a key, a bearer token, a JWT and a long opaque run read as an ellipsis; the command around them stays", () => {
    expect(scrubNoticeText("curl -H 'Authorization: Bearer abc.def.ghi' https://x.test")).toBe(
      `curl -H 'Authorization: Bearer ${ELLIPSIS}' https://x.test`,
    );
    expect(scrubNoticeText("export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789")).toBe(
      `export OPENAI_API_KEY=${ELLIPSIS}`,
    );
    expect(scrubNoticeText("gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz012345")).toBe(
      `gh auth login --with-token ${ELLIPSIS}`,
    );
    expect(scrubNoticeText("set token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZw")).toBe(
      `set token=${ELLIPSIS}`,
    );
    expect(scrubNoticeText("aws s3 ls --profile AKIAIOSFODNN7EXAMPLE")).toBe(`aws s3 ls --profile ${ELLIPSIS}`);
    expect(scrubNoticeText("sha 0123456789abcdef0123456789abcdef01234567 of the file")).toBe(
      `sha ${ELLIPSIS} of the file`,
    );
  });

  test("a path or a sentence of ordinary length is left alone", () => {
    expect(scrubNoticeText("bun test packages/protocol/src/notice-context.test.ts")).toBe(
      "bun test packages/protocol/src/notice-context.test.ts",
    );
    expect(scrubNoticeText("Which database should the migration target?")).toBe(
      "Which database should the migration target?",
    );
  });

  test("control characters and newlines collapse to one space, and the text is capped in the middle", () => {
    expect(scrubNoticeText("run\n\tthis\u001b[31m now\u0007")).toBe("run this now");
    const long = "word ".repeat(60).trim();
    const capped = scrubNoticeText(long);
    expect(Array.from(capped).length).toBe(MAX_NOTICE_TEXT);
    expect(capped).toContain(ELLIPSIS);
  });
});

describe("cutting in the middle", () => {
  test("keeps the start and the end, counted in characters, not UTF-16 units", () => {
    expect(truncateMiddle("abcdefghij", 10)).toBe("abcdefghij");
    expect(truncateMiddle("abcdefghij", 7)).toBe(`abc${ELLIPSIS}hij`);
    expect(truncateMiddle("abcdefghij", 6)).toBe(`abc${ELLIPSIS}ij`);
    expect(truncateMiddle("😀😀😀😀😀😀", 5)).toBe(`😀😀${ELLIPSIS}😀😀`);
    expect(truncateMiddle("한글제목입니다", 4)).toBe(`한글${ELLIPSIS}다`);
    expect(truncateMiddle("abc", 1)).toBe(ELLIPSIS);
  });
});

describe("what a notification says", () => {
  const full = {
    title: "roster sync",
    space: "api-server",
    machine: "build-box",
    asks: "Which database should the migration target?",
  };

  test("with everything known: who and where on the title line, the state and the ask on the body", () => {
    expect(noticeText("input", full)).toEqual({
      title: "roster sync · api-server · build-box",
      body: "Needs your input: Which database should the migration target?",
    });
    expect(noticeText("permission", { ...full, asks: "Claude Code wants to run touch probe-a.txt" })).toEqual({
      title: "roster sync · api-server · build-box",
      body: "Needs permission: Claude Code wants to run touch probe-a.txt",
    });
    expect(noticeText("done", { ...full, asks: "Migration written" }).body).toBe("Finished: Migration written");
    expect(noticeText("error", { ...full, asks: "exit 1" }).body).toBe("Error: exit 1");
  });

  test("a field that is not known is left out, never filled in", () => {
    expect(noticeText("input", { title: "roster sync" })).toEqual({ title: "roster sync", body: "Needs your input" });
    expect(noticeText("done", { space: "api-server", machine: "build-box" })).toEqual({
      title: "api-server · build-box",
      body: "Finished",
    });
    expect(noticeText("input", { asks: "Proceed?" })).toEqual({
      title: "Doriterm",
      body: "Needs your input: Proceed?",
    });
  });

  test("a terminal titled like its space is named once", () => {
    expect(noticeText("done", { title: "api-server", space: "api-server" }).title).toBe("api-server");
  });

  test("no context, or an empty one, is the plain sentence every notice said before: the honest text for a host not reached", () => {
    expect(noticeText("input", undefined)).toEqual({ title: "Doriterm", body: "An agent is waiting for your input." });
    expect(noticeText("permission", {})).toEqual({ title: "Doriterm", body: "An agent is asking for permission." });
    expect(noticeText("done", {}).body).toBe("An agent finished its turn.");
    expect(noticeText("error", {}).body).toBe("An agent stopped with an error.");
  });

  test("an age of a minute or more is shown, a younger one is not", () => {
    expect(noticeText("input", { ...full, ageMs: 59_000 }).body).toBe(
      "Needs your input: Which database should the migration target?",
    );
    expect(noticeText("input", { ...full, ageMs: 2 * 60_000 + 5 }).body).toBe(
      "Needs your input: Which database should the migration target? · 2 min ago",
    );
    expect(noticeText("done", { title: "t", ageMs: 3 * 3_600_000 }).body).toBe("Finished · 3 h ago");
    expect(noticeText("done", { title: "t", ageMs: 49 * 3_600_000 }).body).toBe("Finished · 2 d ago");
  });

  test("a long title part is cut in its middle; parts that still do not fit are dropped from the right", () => {
    const long = "a very long terminal title that goes on and on and on and on";
    const { title } = noticeText("done", { title: long, space: "s", machine: "m" });
    expect(title).toBe(`a very long term${ELLIPSIS}n and on and on · s · m`);
    const crowded = noticeText("done", { title: "x".repeat(32), space: "y".repeat(32), machine: "z".repeat(32) });
    expect(crowded.title).toBe(`${"x".repeat(32)} · ${"y".repeat(32)}`);
    expect(Array.from(crowded.title).length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
  });

  test("a long ask is cut in its middle so the body fits, its end kept", () => {
    const asks = `${"Apply the migration ".repeat(12)}to the staging database?`;
    const { body } = noticeText("input", { title: "t", asks, ageMs: 5 * 60_000 });
    expect(Array.from(body).length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(body.startsWith("Needs your input: Apply the migration")).toBe(true);
    expect(body.endsWith("to the staging database? · 5 min ago")).toBe(true);
    expect(body).toContain(ELLIPSIS);
  });
});

describe("a context on the wire", () => {
  test("well-formed fields are kept and scrubbed; a wrong, empty or too long one is dropped; a non-object is none", () => {
    expect(
      parseNoticeContext({
        title: "roster sync",
        space: "",
        machine: 7,
        asks: "edit /Users/me/notes.md",
        ageMs: 1500.7,
        extra: "ignored",
      }),
    ).toEqual({ title: "roster sync", asks: "edit ~/notes.md", ageMs: 1500 });
    expect(parseNoticeContext({ title: "x".repeat(MAX_NOTICE_TEXT + 1), ageMs: -1 })).toEqual({});
    expect(parseNoticeContext({ ageMs: Number.NaN })).toEqual({});
    expect(parseNoticeContext("roster sync")).toBeUndefined();
    expect(parseNoticeContext(null)).toBeUndefined();
  });

  test("a host's notice line carries it; an older host's line, without one, still parses", () => {
    const line = parsePushHostLine(
      JSON.stringify({ t: "notice", terminal: "t7", kind: "input", context: { title: "roster sync", ageMs: 0 } }),
    );
    expect(line).toEqual({ t: "notice", terminal: "t7", kind: "input", context: { title: "roster sync", ageMs: 0 } });
    expect(parsePushHostLine(JSON.stringify({ t: "notice", terminal: "t7", kind: "input" }))).toEqual({
      t: "notice",
      terminal: "t7",
      kind: "input",
    });
  });

  test("the push payload itself still takes no context: a notice carrying a title is no notice", () => {
    const notice = { v: 1, n: "AAAAAAAAAAAAAAAAAAAAAA", k: "input", h: "abcdefghijklmnopqrstuvwxyz" } as const;
    expect(parsePushNotice(notice)).toEqual(notice);
    expect(parsePushNotice({ ...notice, title: "roster sync" })).toBeUndefined();
    expect(parsePushNotice({ ...notice, context: { title: "roster sync" } })).toBeUndefined();
  });
});
