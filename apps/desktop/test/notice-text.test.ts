import { describe, expect, mock, test } from "bun:test";

// notice.ts reads electron's Notification at load; the text it shows is pure, so any constructor stands in for it here.
mock.module("electron", () => ({ Notification: Object }));
const { noticeText } = await import("../src/main/notice.ts");

describe("what a desktop notification says", () => {
  test("a notice with context names the terminal, its space and machine, then the state and the ask", () => {
    expect(
      noticeText({
        kind: "permission",
        terminal: "box/t7",
        context: {
          title: "roster sync",
          space: "api-server",
          machine: "box",
          asks: "Claude Code wants to run touch probe-a.txt",
        },
      }),
    ).toEqual({
      title: "roster sync · api-server · box",
      body: "Needs permission: Claude Code wants to run touch probe-a.txt",
    });
  });

  test("a notice without context reads the plain sentence, as before", () => {
    expect(noticeText({ kind: "input", terminal: "t7" })).toEqual({
      title: "Doriterm",
      body: "An agent is waiting for your input.",
    });
    expect(noticeText({ kind: "done", terminal: "t7", context: {} }).body).toBe("An agent finished its turn.");
  });

  test("a test notice keeps its own words", () => {
    expect(noticeText({ kind: "test", terminal: null })).toEqual({
      title: "Doriterm",
      body: "Notifications on this computer work.",
    });
  });
});
