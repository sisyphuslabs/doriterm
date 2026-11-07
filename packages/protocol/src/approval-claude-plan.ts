import {
  aboveBlank,
  AGENT,
  ASKED,
  CANCEL,
  cursorOf,
  detailedRows,
  DIALOG_ROWS,
  isNo,
  option,
  rowsEnd,
  rowText,
} from "./approval-claude-rows.ts";
import { bodyText, contextAbove, type Found, indent, lastIndex, ruleAt, type ScreenPrompt } from "./approval-rows.ts";

const PLAN_QUESTION = /Would you like to proceed\?\s*$/;
const EXIT_PLAN_QUESTION = /^\s*Exit plan mode\?\s*$/;
const PLAN_HEADING = /^\s*Here is Claude's plan:\s*$/;
const PLAN_FILE = /·\s+(\S+\.md)\s*$/;
const PLAN_TYPED = /^Tell Claude what to change\b/;

/**
 * The plan between the dialog's own two ╌ rules under "Here is Claude's plan:", and the rule the dialog starts at.
 * Every rule here is drawn at the dialog's border column: the plan's own text sits inside the box's padding, so a
 * rule or a heading it draws is never taken for the dialog's.
 */
function planOf(lines: readonly string[], rule: number, border: number) {
  const close = aboveBlank(lines, rule);
  if (!ruleAt(lines[close] ?? "", border, "╌")) return { plan: [], top: rule };
  const open = lastIndex(lines, (line) => ruleAt(line, border, "╌"), close - 1);
  const heading = aboveBlank(lines, open);
  if (open === -1 || !PLAN_HEADING.test(lines[heading] ?? "") || indent(lines[heading] ?? "") !== border + 1)
    return { plan: [], top: rule };
  const top = lastIndex(lines, (line) => ruleAt(line, border, "─"), heading);
  return { plan: lines.slice(open + 1, close), top: top === -1 ? rule : top };
}

/**
 * Claude Code's plan approval in plan mode, as 2.1.311 draws it:
 *
 *     ──────────────
 *      Ready to code?
 *      Here is Claude's plan:
 *     ╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 *      Add the users migration ...         (the plan)
 *     ╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 *     ──────────────
 *      Claude has written up a plan and is ready to execute. Would you like to proceed?
 *      ❯ 1. Yes, and use auto mode
 *        2. Yes, manually approve edits
 *        3. Tell Claude what to change     (the cursor on it takes typed feedback)
 *           shift+tab to approve with this feedback
 *      ctrl+g to edit in Vim · ~/.claude/plans/<name>.md
 *
 * With no plan written it asks "Exit plan mode?" with Yes and No rows instead.
 */
export function readPlan(lines: readonly string[]): Found | undefined {
  // The question opens its own dialog, right under the dialog's top rule, drawn one column left of it (the box's
  // border): the agent's own words saying "Would you like to proceed?" anywhere else on the screen are not this dialog.
  const question = lastIndex(
    lines,
    (line, index) =>
      (PLAN_QUESTION.test(line) || EXIT_PLAN_QUESTION.test(line)) &&
      ruleAt(lines[aboveBlank(lines, index)] ?? "", indent(line) - 1, "─"),
  );
  if (question === -1) return undefined;
  const below = lines.slice(question + 1, question + 1 + DIALOG_ROWS);
  const last = rowsEnd(below);
  if (last === -1) return undefined;
  const rows = detailedRows(below.slice(0, last + 1));
  const footerAt = below.findIndex((line, index) => index > last && line.trim() !== "");
  const footer = footerAt !== -1 && PLAN_FILE.test(below[footerAt] ?? "") ? below[footerAt] : undefined;
  const file = footer === undefined ? undefined : PLAN_FILE.exec(footer)?.[1];
  const rule = aboveBlank(lines, question);
  const { plan, top } = planOf(lines, rule, indent(lines[question] ?? "") - 1);
  const body = bodyText(plan.map((line) => line.trimStart()));
  const asked = (lines[question] ?? "").trim();
  const options = rows.map((row) => option(row, { declines: isNo(row.label), typed: PLAN_TYPED.test(row.label) }));
  const cursor = cursorOf(rows);
  const prompt: ScreenPrompt = {
    agent: AGENT,
    kind: "plan",
    asks: body === "" ? "wants to leave plan mode" : "has a plan ready",
    question: asked,
    command: body === "" ? asked : (body.split("\n")[0] ?? asked),
    body,
    context: contextAbove(lines, top, ASKED),
    files: file === undefined ? [] : [file],
    multi: false,
    options,
    cancel: CANCEL,
    ...(cursor === undefined ? {} : { cursor, typing: options.some((row) => row.id === cursor && row.typed) }),
    block: [body, asked, ...options.map(rowText), footer?.trim() ?? ""].join("\n"),
  };
  return { prompt, end: question + 1 + (footer === undefined ? last : footerAt) };
}
