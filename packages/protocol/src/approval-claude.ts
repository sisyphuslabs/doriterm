import { readPlan } from "./approval-claude-plan.ts";
import { readQuestion } from "./approval-claude-question.ts";
import {
  AGENT,
  ASKED,
  CANCEL,
  cursorOf,
  DIALOG_ROWS,
  isNo,
  option,
  PERMISSION_FOOTER,
} from "./approval-claude-rows.ts";
import {
  bodyText,
  contextAbove,
  type Found,
  indent,
  lastIndex,
  liveDialog,
  optionRows,
  ruleAt,
  type ScreenPrompt,
} from "./approval-rows.ts";

const TIP = /^\s*Tip:/;
const PERMISSION_QUESTION = /^\s*Do you want to .+\?\s*$/;

/**
 * Claude Code's permission dialog, as 2.1.306 and 2.1.311 draw it under hc:
 *
 *     ──────────────
 *      Bash command                         Edit file / Create file
 *      Tip: ...                  (sometimes) notes.md                  (the file)
 *      Create the probe file     (the tool's description)
 *     ╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 *      touch probe-a.txt                    the diff, or the new file's text
 *     ╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 *      Do you want to proceed?              Do you want to make this edit to notes.md?
 *      ❯ 1. Yes
 *        2. Yes, and always allow ...
 *        3. No
 *      Esc to cancel · Tab to amend
 *
 * Each row's number picks it wherever the cursor sits (Enter would confirm the cursor's row); Esc is the dialog's cancel.
 * The dialog's rules are its box's border, one column left of its question; the command, diff or file between them
 * sits inside the box's padding, so a rule it draws is never one of the dialog's own.
 */
function readPermission(lines: readonly string[]): Found | undefined {
  const question = lastIndex(lines, (line) => PERMISSION_QUESTION.test(line));
  if (question === -1) return undefined;
  const below = lines.slice(question + 1, question + 1 + DIALOG_ROWS);
  const footerAt = below.findIndex((line) => PERMISSION_FOOTER.test(line));
  if (footerAt === -1) return undefined;
  const rows = optionRows(below.slice(0, footerAt));
  if (rows.length === 0) return undefined;

  const border = indent(lines[question] ?? "") - 1;
  const top = lastIndex(lines, (line) => ruleAt(line, border, "─"), question);
  if (top === -1) return undefined;
  const body = lines.slice(top + 1, question);
  const ownRule = (line: string) => ruleAt(line, border, "╌");
  const words = body.filter((line) => line.trim() !== "" && !TIP.test(line) && !ownRule(line));
  const header = words[0]?.trim() ?? "";
  const rules = body.flatMap((line, index) => (ownRule(line) ? [index] : []));
  const between = rules.length >= 2 ? body.slice((rules[0] ?? 0) + 1, rules.at(-1)) : [];
  const asked = lines[question]?.trim() ?? "";
  const shown = between
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
  const edit = /^(Edit|Create) file$/.exec(header);
  const file = edit === null ? undefined : words[1]?.trim();
  const command = file ?? (shown === "" ? asked.replace(/^Do you want to /, "") : shown);
  if (command === "") return undefined;
  const description = body
    .slice(0, rules[0] ?? body.length)
    .filter((line) => line.trim() !== "" && !TIP.test(line))
    .slice(1);

  const block = [
    ...body.filter((line) => !TIP.test(line)).map((line) => line.trim()),
    asked,
    ...rows.map((row) => `${row.number}. ${row.label}`),
    below[footerAt]?.trim() ?? "",
  ].join("\n");
  const cursor = cursorOf(rows);
  const prompt: ScreenPrompt = {
    agent: AGENT,
    kind: "permission",
    asks: /^Bash\b/.test(header)
      ? "wants to run"
      : edit?.[1] === "Edit"
        ? "wants to edit"
        : edit?.[1] === "Create"
          ? "wants to create"
          : "asks for permission",
    question: asked,
    command,
    body: bodyText(file === undefined ? description.map((line) => line.trim()) : between),
    context: contextAbove(lines, top, ASKED),
    files: file === undefined ? [] : [file],
    multi: false,
    options: rows.map((row) => option(row, { declines: isNo(row.label) })),
    cancel: CANCEL,
    ...(cursor === undefined ? {} : { cursor }),
    block,
  };
  return { prompt, end: question + 1 + footerAt };
}

/**
 * Whichever of Claude Code's dialogs is up: the one drawn at the bottom of the screen. A line of the agent's own text
 * above it, or text inside its body, that looks like another dialog never stands for it, whatever kind it reads as.
 */
export function readClaudePrompt(lines: readonly string[]): ScreenPrompt | undefined {
  return liveDialog(lines, [readQuestion(lines), readPlan(lines), readPermission(lines)]);
}
