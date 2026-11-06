import { describe, expect, test } from "bun:test";
import {
  CLAUDE_NO_TASKS_SCREEN,
  CLAUDE_TASKS_DONE_SCREEN,
  CLAUDE_TASKS_FOLDED_SCREEN,
  CLAUDE_TASKS_HEADER_SCREEN,
  CLAUDE_TASKS_WORKING_SCREEN,
  OMP_TODO_DONE_SCREEN,
  OMP_TODO_PHASES_SCREEN,
  OMP_TODO_SCREEN,
} from "./testing/todo-screens.ts";
import { readTodoProgress } from "./todo-screen.ts";

describe("readTodoProgress: Claude Code's task list", () => {
  test("while it works: the rows under the spinner, done ones counted", () => {
    expect(readTodoProgress("claude-code", CLAUDE_TASKS_WORKING_SCREEN)).toEqual({ done: 2, total: 4 });
  });

  test("a long list folds into one line, whose counts are added", () => {
    expect(readTodoProgress("claude-code", CLAUDE_TASKS_FOLDED_SCREEN)).toEqual({ done: 5, total: 12 });
  });

  test("the count line above the rows is read as it says", () => {
    expect(readTodoProgress("claude-code", CLAUDE_TASKS_DONE_SCREEN)).toEqual({ done: 3, total: 3 });
    expect(readTodoProgress("claude-code", CLAUDE_TASKS_HEADER_SCREEN)).toEqual({ done: 2, total: 4 });
  });

  test("no list on the screen: nothing", () => {
    expect(readTodoProgress("claude-code", CLAUDE_NO_TASKS_SCREEN)).toBeUndefined();
  });

  test("the folded line's other words count toward the total, and a done count among them toward done", () => {
    const screen = [
      "✻ Working… (3s)",
      "  ⎿  ◼ First",
      "     ◻ Second",
      "      … +4 completed, 2 pending",
      "─".repeat(20),
      "❯ ",
    ];
    expect(readTodoProgress("claude-code", screen.join("\n"))).toEqual({ done: 4, total: 8 });
  });

  test("only the last list on the screen counts: an earlier one in the transcript is history", () => {
    const screen = [
      "  ⎿  ✔ Old one",
      "     ◻ Old two",
      "",
      "● Next",
      "✻ Working… (3s)",
      "  ⎿  ✔ New one",
      "     ✔ New two",
      "     ◼ New three",
    ];
    expect(readTodoProgress("claude-code", screen.join("\n"))).toEqual({ done: 2, total: 3 });
  });

  test.each([
    "✻ Doing step 6… (1m 21s · ↓ 3.2k tokens)",
    "✻ Doing step 6… (1h 2m 3s · ↓ 3.2k tokens)",
    "✻ Doing step 6… (esc to interrupt · 1m 43s · ↓ 3.2k tokens)",
  ])("a turn past a minute keeps its list: %s", (spinner) => {
    const screen = [spinner, "  ⎿  ✔ First", "     ✔ Second", "     ◼ Third", "     ◻ Fourth", "─".repeat(20), "❯ "];
    expect(readTodoProgress("claude-code", screen.join("\n"))).toEqual({ done: 2, total: 4 });
  });

  test("check marks in the agent's reply are not a task list", () => {
    const screen = [
      "❯ Do the task.",
      "",
      "● Done. Summary:",
      "  ✔ Fixed the parser",
      "  ✔ Ran the suite",
      "",
      "─".repeat(20),
      "❯ ",
    ];
    expect(readTodoProgress("claude-code", screen.join("\n"))).toBeUndefined();
  });

  test("test output under a tool call is not a task list", () => {
    const screen = [
      "● Bash(node --test)",
      "  ⎿  ✔ parses a header (2ms)",
      "     ✔ folds a long list (1ms)",
      "",
      "─".repeat(20),
      "❯ ",
    ];
    expect(readTodoProgress("claude-code", screen.join("\n"))).toBeUndefined();
  });

  test("rows under the spinner count only when the spinner line is right above them", () => {
    const screen = ["● Ran 1 shell command", "  ⎿  ✔ First", "     ◻ Second", "─".repeat(20), "❯ "];
    expect(readTodoProgress("claude-code", screen.join("\n"))).toBeUndefined();
  });

  test("an AskUserQuestion tab row is not a task list", () => {
    expect(readTodoProgress("claude-code", "←  ☒ Runtime  ☐ Deploy  ✔ Submit  →")).toBeUndefined();
  });
});

describe("readTodoProgress: omp's TODO list", () => {
  test("one phase: its own count", () => {
    expect(readTodoProgress("omp", OMP_TODO_SCREEN)).toEqual({ done: 1, total: 4 });
  });

  test("several phases, one folded: their counts added up", () => {
    expect(readTodoProgress("omp", OMP_TODO_PHASES_SCREEN)).toEqual({ done: 1, total: 5 });
    expect(readTodoProgress("omp", OMP_TODO_DONE_SCREEN)).toEqual({ done: 3, total: 5 });
  });

  test("the tool's own card in the transcript is not the list, and no TODO line is nothing", () => {
    expect(readTodoProgress("omp", "╭─── ☑ Todo 4 tasks ───╮\n│ ├─ ☑ Fix the parser │")).toBeUndefined();
    expect(readTodoProgress("omp", CLAUDE_TASKS_WORKING_SCREEN)).toBeUndefined();
  });

  test("a TODO line with no phase under it is nothing", () => {
    expect(readTodoProgress("omp", " TODO\n\n  ⎋ Working…")).toBeUndefined();
  });
});

describe("readTodoProgress: other agents", () => {
  test("an agent with no reader gets nothing, whatever the screen shows", () => {
    expect(readTodoProgress("codex", CLAUDE_TASKS_WORKING_SCREEN)).toBeUndefined();
    expect(readTodoProgress("codex", OMP_TODO_SCREEN)).toBeUndefined();
    expect(readTodoProgress("", CLAUDE_TASKS_WORKING_SCREEN)).toBeUndefined();
    expect(readTodoProgress("constructor", CLAUDE_TASKS_WORKING_SCREEN)).toBeUndefined();
  });
});
