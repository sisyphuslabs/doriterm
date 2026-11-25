import { describe, expect, test } from "bun:test";
import { answerApproval, CLAIM_TTL_MS, readApprovalRecord } from "./approval-answer.ts";
import { markApproval } from "./approval-prompt.ts";
import { binaryReply, type PromptReply, replyKeys, typedAnswer } from "./approval-reply.ts";
import type { ScreenPrompt } from "./approval-rows.ts";
import { readScreenPrompt } from "./approval-screen.ts";
import { MemoryApprovalCore } from "./testing/approval-core.ts";
import { CLAUDE_BLOCKED, CODEX_BLOCKED, terminalAt } from "./testing/approval-terminal.ts";
import * as screens from "./testing/prompt-screens.ts";

const claude = (screen: string): ScreenPrompt => {
  const prompt = readScreenPrompt("claude-code", screen);
  if (prompt === undefined) throw new Error("no Claude Code prompt on the screen");
  return prompt;
};
const codex = (screen: string): ScreenPrompt => {
  const prompt = readScreenPrompt("codex", screen);
  if (prompt === undefined) throw new Error("no Codex prompt on the screen");
  return prompt;
};

describe("the agent's keys for an answer, worked out on the live screen", () => {
  test.each<[string, ScreenPrompt, PromptReply, readonly string[] | undefined]>([
    ["a row's own number", claude(screens.CLAUDE_QUESTION_SCREEN), { kind: "option", option: "2" }, ["2"]],
    ["a Codex row's own letter", codex(screens.CODEX_EXEC_167_SCREEN), { kind: "option", option: "2" }, ["p"]],
    ["the agent's No row", claude(screens.CLAUDE_EDIT_SCREEN), { kind: "option", option: "3" }, ["3"]],
    ["the dialog's cancel", claude(screens.CLAUDE_QUESTION_SCREEN), { kind: "cancel" }, ["esc"]],
    [
      "Claude Code's typed row: its number moves the cursor there",
      claude(screens.CLAUDE_QUESTION_SCREEN),
      { kind: "text", option: "4", text: "MySQL 8" },
      ["4"],
    ],
    [
      "Codex's typed row: ↓ from the cursor, then Tab opens its notes",
      codex(screens.CODEX_QUESTION_SCREEN),
      { kind: "text", option: "3", text: "MySQL 8" },
      ["down", "down", "tab"],
    ],
    [
      "multi-select: toggle only the boxes that differ from what is wanted, then submit",
      claude(screens.CLAUDE_MULTI_CHECKED_SCREEN),
      { kind: "checked", options: ["3"] },
      ["1", "3", "right"],
    ],
    [
      "multi-select with nothing to change still submits",
      claude(screens.CLAUDE_MULTI_CHECKED_SCREEN),
      { kind: "checked", options: ["1"] },
      ["right"],
    ],
    [
      "a row the dialog does not have",
      claude(screens.CLAUDE_QUESTION_SCREEN),
      { kind: "option", option: "9" },
      undefined,
    ],
    [
      "text for a row that takes none",
      claude(screens.CLAUDE_QUESTION_SCREEN),
      { kind: "text", option: "2", text: "x" },
      undefined,
    ],
    [
      "a typed row picked without text",
      claude(screens.CLAUDE_QUESTION_SCREEN),
      { kind: "option", option: "4" },
      undefined,
    ],
    [
      "boxes on a single-choice dialog",
      claude(screens.CLAUDE_QUESTION_SCREEN),
      { kind: "checked", options: ["1"] },
      undefined,
    ],
    ["a box picked as a single row", claude(screens.CLAUDE_MULTI_SCREEN), { kind: "option", option: "1" }, undefined],
    ["a cancel the dialog does not offer", claude(screens.CLAUDE_REVIEW_SCREEN), { kind: "cancel" }, undefined],
  ])("%s", (_, prompt, reply, keys) => {
    expect(replyKeys(prompt, reply)).toEqual(keys);
  });

  test("typed text is pasted as one plain line: no line break to submit half of it, no escape sequence to press keys", () => {
    expect(typedAnswer("  MySQL\n8\u001B[A\u0007 ")).toBe("MySQL 8 [A");
    expect(typedAnswer("\n\t ")).toBeUndefined();
    expect(typedAnswer("x".repeat(5000))).toHaveLength(2000);
  });

  test("Allow and Deny map to the plain Yes row and the cancel, and to nothing on a question", () => {
    expect(binaryReply(claude(screens.CLAUDE_BASH_311_SCREEN), "allow")).toEqual({ kind: "option", option: "1" });
    expect(binaryReply(codex(screens.CODEX_PATCH_SCREEN), "allow")).toEqual({ kind: "option", option: "1" });
    expect(binaryReply(claude(screens.CLAUDE_BASH_311_SCREEN), "deny")).toEqual({ kind: "cancel" });
    expect(binaryReply(claude(screens.CLAUDE_QUESTION_SCREEN), "allow")).toBeUndefined();
  });
});

const phone = { by: "phone", client: "phone-1" };
const noWait = () => Promise.resolve();

describe("answering every prompt shape", () => {
  test("a question's row: its key, recorded in the agent's own words", async () => {
    const terminal = terminalAt("t3", { ...CLAUDE_BLOCKED, kind: "question" });
    const core = new MemoryApprovalCore(terminal, screens.CLAUDE_QUESTION_SCREEN);
    const mark = markApproval(terminal, screens.CLAUDE_QUESTION_SCREEN);
    if (mark === undefined) throw new Error("no prompt");
    expect(await answerApproval(core, mark, { kind: "option", option: "2" }, phone, 1)).toEqual({ kind: "sent" });
    expect(core.pressed).toEqual([{ address: "t3", keys: ["2"] }]);
    expect(await readApprovalRecord(core, mark)).toMatchObject({ answer: "allow", choice: "SQLite", outcome: "sent" });
  });

  test("a typed answer: the row's key, then the text once the live screen shows the row open", async () => {
    const terminal = terminalAt("t3", { ...CLAUDE_BLOCKED, kind: "question" });
    const core = new MemoryApprovalCore(terminal, screens.CLAUDE_QUESTION_SCREEN);
    core.showAfterKeys(screens.CLAUDE_QUESTION_TYPING_SCREEN);
    const mark = markApproval(terminal, screens.CLAUDE_QUESTION_SCREEN);
    if (mark === undefined) throw new Error("no prompt");
    const reply: PromptReply = { kind: "text", option: "4", text: "MySQL 8\n" };
    expect(await answerApproval(core, mark, reply, phone, 1, { pause: noWait })).toEqual({ kind: "sent" });
    expect(core.pressed).toEqual([{ address: "t3", keys: ["4"] }]);
    expect(core.sent).toEqual([{ address: "t3", text: "MySQL 8" }]);
  });

  test.each(["closed", "open"] as const)("a document read fails while the typed row is %s", async (failWhen) => {
    const terminal = terminalAt("t3", { ...CLAUDE_BLOCKED, kind: "question" });
    const core = new MemoryApprovalCore(terminal, screens.CLAUDE_QUESTION_SCREEN);
    const mark = markApproval(terminal, screens.CLAUDE_QUESTION_SCREEN);
    if (mark === undefined) throw new Error("no prompt");
    let polls = 0;
    const pause = () => {
      const open = ++polls >= 2;
      if (open) core.show(terminal, screens.CLAUDE_QUESTION_TYPING_SCREEN);
      if (polls === (failWhen === "closed" ? 1 : 2)) core.failNext("doc");
      return noWait();
    };
    const reply: PromptReply = { kind: "text", option: "4", text: "MySQL 8" };
    const result = await answerApproval(core, mark, reply, phone, 1, { pause });
    const outcome = failWhen === "closed" ? "sent" : "unknown";
    expect(result.kind).toBe(outcome);
    expect(await readApprovalRecord(core, mark)).toMatchObject({ outcome });
    expect(core.pressed).toEqual([{ address: "t3", keys: ["4"] }]);
    expect(core.sent).toEqual(failWhen === "closed" ? [{ address: "t3", text: "MySQL 8" }] : []);
  });

  test("a typed answer whose row never opens: the keys were pressed, the text is not sent, and the outcome is unknown", async () => {
    const terminal = terminalAt("t3", { ...CLAUDE_BLOCKED, kind: "question" });
    const core = new MemoryApprovalCore(terminal, screens.CLAUDE_QUESTION_SCREEN);
    const mark = markApproval(terminal, screens.CLAUDE_QUESTION_SCREEN);
    if (mark === undefined) throw new Error("no prompt");
    const reply: PromptReply = { kind: "text", option: "4", text: "MySQL 8" };
    expect(await answerApproval(core, mark, reply, phone, 1, { pause: noWait })).toMatchObject({ kind: "unknown" });
    expect(core.sent).toEqual([]);
    expect(await readApprovalRecord(core, mark)).toMatchObject({ outcome: "unknown" });
  });

  test("a claim that lapses while the typed row opens: the keys were pressed, the text is not sent, unknown", async () => {
    const terminal = terminalAt("t3", { ...CLAUDE_BLOCKED, kind: "question" });
    const core = new MemoryApprovalCore(terminal, screens.CLAUDE_QUESTION_SCREEN);
    core.showAfterKeys(screens.CLAUDE_QUESTION_TYPING_SCREEN);
    const mark = markApproval(terminal, screens.CLAUDE_QUESTION_SCREEN);
    if (mark === undefined) throw new Error("no prompt");
    let wallMs = 0;
    // The device sleeps while the row opens: its own wall clock moves past the claim's lifetime.
    const pause = async () => void (wallMs += CLAIM_TTL_MS);
    const reply: PromptReply = { kind: "text", option: "4", text: "MySQL 8" };
    const result = await answerApproval(core, mark, reply, phone, 1, { pause, wall: () => wallMs });
    expect(result).toMatchObject({ kind: "unknown" });
    expect(core.pressed).toEqual([{ address: "t3", keys: ["4"] }]);
    expect(core.sent).toEqual([]);
  });

  test("Codex notes: ↓ to the typed row from where the cursor is, Tab, then the text", async () => {
    const terminal = terminalAt("t5", { ...CODEX_BLOCKED, kind: "question" });
    const core = new MemoryApprovalCore(terminal, screens.CODEX_QUESTION_SCREEN);
    core.showAfterKeys(screens.CODEX_NOTES_SCREEN);
    const mark = markApproval(terminal, screens.CODEX_QUESTION_SCREEN);
    if (mark === undefined) throw new Error("no prompt");
    const reply: PromptReply = { kind: "text", option: "3", text: "MySQL 8" };
    expect(await answerApproval(core, mark, reply, phone, 1, { pause: noWait })).toEqual({ kind: "sent" });
    expect(core.pressed).toEqual([{ address: "t5", keys: ["down", "down", "tab"] }]);
    expect(core.sent).toEqual([{ address: "t5", text: "MySQL 8" }]);
  });

  test("multi-select: the boxes as the live screen has them decide the toggles", async () => {
    const terminal = terminalAt("t3", { ...CLAUDE_BLOCKED, kind: "question" });
    const core = new MemoryApprovalCore(terminal, screens.CLAUDE_MULTI_SCREEN);
    const mark = markApproval(terminal, screens.CLAUDE_MULTI_SCREEN);
    if (mark === undefined) throw new Error("no prompt");
    const reply: PromptReply = { kind: "checked", options: ["1", "3"] };
    expect(await answerApproval(core, mark, reply, phone, 1)).toEqual({ kind: "sent" });
    expect(core.pressed).toEqual([{ address: "t3", keys: ["1", "3", "right"] }]);
    expect(await readApprovalRecord(core, mark)).toMatchObject({ choice: "Lint, Unit tests" });
  });

  test("a box checked in the terminal after the card read it is another prompt: nothing is pressed", async () => {
    const terminal = terminalAt("t3", { ...CLAUDE_BLOCKED, kind: "question" });
    const core = new MemoryApprovalCore(terminal, screens.CLAUDE_MULTI_SCREEN);
    const mark = markApproval(terminal, screens.CLAUDE_MULTI_SCREEN);
    if (mark === undefined) throw new Error("no prompt");
    core.show(terminal, screens.CLAUDE_MULTI_CHECKED_SCREEN);
    expect(await answerApproval(core, mark, { kind: "checked", options: ["3"] }, phone, 1)).toEqual({ kind: "stale" });
    expect(core.pressed).toEqual([]);
  });

  test("one step of several: its answer moves the dialog on, and the next step is a prompt of its own", async () => {
    const terminal = terminalAt("t3", { ...CLAUDE_BLOCKED, kind: "question" });
    const core = new MemoryApprovalCore(terminal, screens.CLAUDE_STEPS_SCREEN);
    const first = markApproval(terminal, screens.CLAUDE_STEPS_SCREEN);
    if (first === undefined) throw new Error("no prompt");
    expect(await answerApproval(core, first, { kind: "option", option: "2" }, phone, 1)).toEqual({ kind: "sent" });
    core.show(terminal, screens.CLAUDE_STEPS_SECOND_SCREEN);
    const second = markApproval(terminal, screens.CLAUDE_STEPS_SECOND_SCREEN);
    if (second === undefined) throw new Error("no second step");
    expect(second.screen).not.toBe(first.screen);
    expect(await answerApproval(core, first, { kind: "option", option: "1" }, phone, 2)).toMatchObject({
      kind: "lost",
      record: { choice: "Node", outcome: "sent" },
    });
    expect(await answerApproval(core, second, { kind: "option", option: "1" }, phone, 3)).toEqual({ kind: "sent" });
    expect(core.pressed.map((press) => press.keys)).toEqual([["2"], ["1"]]);
  });

  test("a plan's No row and a cancel are recorded as declines, for clients that only know Deny", async () => {
    const terminal = terminalAt("t3", CLAUDE_BLOCKED);
    const core = new MemoryApprovalCore(terminal, screens.CLAUDE_EXIT_PLAN_SCREEN);
    const mark = markApproval(terminal, screens.CLAUDE_EXIT_PLAN_SCREEN);
    if (mark === undefined) throw new Error("no prompt");
    expect(await answerApproval(core, mark, { kind: "option", option: "2" }, phone, 1)).toEqual({ kind: "sent" });
    expect(await readApprovalRecord(core, mark)).toMatchObject({ answer: "deny", choice: "No" });
  });
});
