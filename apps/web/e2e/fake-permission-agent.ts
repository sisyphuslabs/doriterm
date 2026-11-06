// `bun e2e/fake-permission-agent.ts <log> [permission|question|steps|multi]`: a program that asks the way Claude Code
// does under hc. It reports working and then `blocked` over OSC 7501 (as `app: claude-code`, `kind: permission` or
// `kind: question`), draws Claude Code's own dialog (copied from real sessions: 2.1.306's Bash permission, 2.1.311's
// questions) to the terminal's width, and logs every key it receives to <log>: a chunk is split into keystrokes (an
// escape sequence, a lone Esc, one character), as a terminal program reads them.
//
// permission: `1` allows, Esc or `4` (its No row) declines, and `x` stands for a person answering in the terminal before the status catches
// up (the dialog goes, the status stays blocked). question: a row's number answers; `4` puts the cursor on "Type
// something.", where pasted text and Enter answer. steps: two questions, then Claude Code's review, where `1` submits.
// multi: numbers toggle boxes, → moves to the review, `1` submits.
import { appendFileSync } from "node:fs";
import { CLAUDE_PROMPT_SCREEN } from "../../../packages/protocol/src/testing/approval-screens.ts";
import {
  CLAUDE_MULTI_SCREEN,
  CLAUDE_QUESTION_SCREEN,
  CLAUDE_QUESTION_TYPING_SCREEN,
  CLAUDE_REVIEW_SCREEN,
  CLAUDE_STEPS_SCREEN,
  CLAUDE_STEPS_SECOND_SCREEN,
} from "../../../packages/protocol/src/testing/prompt-screens.ts";

const [log, scenario = "permission"] = process.argv.slice(2);
if (log === undefined) throw new Error("usage: fake-permission-agent.ts <log> [permission|question|steps|multi]");

const ESC = "\u001B";
const RIGHT = `${ESC}[C`;
const report = (fields: string) => process.stdout.write(`${ESC}]7501;${fields}${ESC}\\`);
const width = () => Math.max(20, (process.stdout.columns ?? 80) - 1);
const fit = (line: string) =>
  /^\s*([─╌])\1+$/.test(line) ? (line.trim()[0] ?? "─").repeat(width()) : line.slice(0, width());
const draw = (rows: readonly string[]) => process.stdout.write(`${ESC}[2J${ESC}[H${rows.map(fit).join("\r\n")}`);
/** A recorded screen from the person's message down: the transcript and the dialog, without Claude Code's banner. */
const dialogOf = (screen: string) => {
  const lines = screen.split("\n");
  return lines.slice(lines.findIndex((line) => line.startsWith("❯ Do the task.")));
};
const finish = (answer: string) => {
  draw(["❯ Do the task.", "", "● User answered Claude's questions:", `  ⎿  ${answer}`, ""]);
  report("state=working:app=claude-code");
  report("state=idle:app=claude-code");
};
const cancel = () => {
  draw(["❯ Do the task.", "", "  ⎿  Interrupted · What should Claude do instead?", ""]);
  report("state=idle:app=claude-code");
};

type Step = (key: string) => void;

function permission(): Step {
  const lines = CLAUDE_PROMPT_SCREEN.split("\n");
  const dialog = lines.slice(lines.findIndex((line) => /^─{10,}$/.test(line)));
  const transcript = ["❯ Create the probe files.", "", "● Creating the probe file", "  ⎿  $ touch probe-a.txt", ""];
  report("state=working:app=claude-code");
  draw([...transcript, ...dialog]);
  report("state=blocked:kind=permission:app=claude-code");
  return (key) => {
    if (key === "1") {
      draw([...transcript.slice(0, 3), "● Bash(touch probe-a.txt)", "  ⎿  Allowed", ""]);
      report("state=working:app=claude-code");
      report("state=idle:app=claude-code");
    } else if (key === ESC || key === "4") cancel();
    else if (key === "x") draw([...transcript.slice(0, 3), "  ⎿  Answered in the terminal", ""]);
  };
}

function question(): Step {
  let typing = false;
  let typed = "";
  draw(dialogOf(CLAUDE_QUESTION_SCREEN));
  report("state=blocked:kind=question:app=claude-code");
  const labels: Readonly<Record<string, string>> = {
    "1": "Postgres",
    "2": "SQLite",
    "3": "Both",
    "5": "Chat about this",
  };
  return (key) => {
    if (typing) {
      if (key === "\r") finish(`· Which database should the migration target? → ${typed}`);
      else if (!key.startsWith(ESC)) typed += key;
    } else if (key === "4") {
      typing = true;
      draw(dialogOf(CLAUDE_QUESTION_TYPING_SCREEN));
    } else if (labels[key] !== undefined) finish(`· Which database should the migration target? → ${labels[key]}`);
    else if (key === ESC) cancel();
  };
}

function steps(): Step {
  const answers: string[] = [];
  draw(dialogOf(CLAUDE_STEPS_SCREEN));
  report("state=blocked:kind=question:app=claude-code");
  return (key) => {
    if (key === ESC) return cancel();
    if (answers.length === 0 && (key === "1" || key === "2")) {
      answers.push(key === "1" ? "Bun" : "Node");
      draw(dialogOf(CLAUDE_STEPS_SECOND_SCREEN));
    } else if (answers.length === 1 && (key === "1" || key === "2")) {
      answers.push(key === "1" ? "Fly" : "Workers");
      draw(
        dialogOf(CLAUDE_REVIEW_SCREEN).map((line) =>
          line.replace("→ Node", `→ ${answers[0] ?? ""}`).replace("→ Fly", `→ ${answers[1] ?? ""}`),
        ),
      );
    } else if (answers.length === 2 && key === "1") finish(answers.join(", "));
    else if (answers.length === 2 && key === "2") cancel();
  };
}

function multi(): Step {
  const labels: Readonly<Record<string, string>> = { "1": "Lint", "2": "Typecheck", "3": "Unit tests" };
  const checked = new Set<string>();
  let review = false;
  const screen = () =>
    dialogOf(CLAUDE_MULTI_SCREEN).map((line) =>
      Object.entries(labels).reduce(
        (drawn, [id, label]) => (checked.has(id) ? drawn.replace(`${id}. [ ] ${label}`, `${id}. [✔] ${label}`) : drawn),
        line,
      ),
    );
  draw(screen());
  report("state=blocked:kind=question:app=claude-code");
  return (key) => {
    if (key === ESC) return cancel();
    if (review) {
      if (key === "1") finish([...checked].map((id) => labels[id]).join(", "));
      else if (key === "2") cancel();
      return;
    }
    if (labels[key] !== undefined) {
      if (checked.has(key)) checked.delete(key);
      else checked.add(key);
      draw(screen());
    } else if (key === RIGHT) {
      review = true;
      const chosen = [...checked].map((id) => labels[id]).join(", ");
      draw([
        "❯ Do the task.",
        "",
        "● I can add several checks to CI.",
        "─".repeat(80),
        "←  ☒ CI checks  ✔ Submit  →",
        "",
        "Review your answers",
        "",
        " ● Which checks should CI run on every push?",
        `   → ${chosen}`,
        "",
        "Ready to submit your answers?",
        "",
        "❯ 1. Submit answers",
        "  2. Cancel",
      ]);
    }
  };
}

const SCENARIOS: Readonly<Record<string, () => Step>> = { permission, question, steps, multi };
const start = SCENARIOS[scenario];
if (start === undefined) throw new Error(`no scenario ${scenario}`);
const step = start();

process.stdin.setRawMode(true);
// oxlint-disable-next-line no-control-regex -- escape sequences are exactly what is split out
const KEYSTROKE = /\u001B\[[\d;]*[A-Za-z~]|\u001B|[\s\S]/gu;
process.stdin.on("data", (bytes: Buffer) => {
  for (const key of bytes.toString("utf8").match(KEYSTROKE) ?? []) {
    appendFileSync(log, `${JSON.stringify(key)}\n`);
    step(key);
  }
});
