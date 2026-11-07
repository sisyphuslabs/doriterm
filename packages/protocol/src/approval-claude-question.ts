import {
  AGENT,
  ASKED,
  CANCEL,
  CHECKBOX,
  cursorOf,
  detailedRows,
  option,
  PERMISSION_FOOTER,
  rowText,
} from "./approval-claude-rows.ts";
import {
  bodyText,
  contextAbove,
  type Found,
  lastIndex,
  numberColumn,
  optionRow,
  type PromptOption,
  type PromptStep,
  ruleAt,
  type ScreenPrompt,
} from "./approval-rows.ts";

/** AskUserQuestion's footer, and the tab row under its top rule: `←  ☐ Runtime  ☒ Deploy  ✔ Submit  →`. */
const QUESTION_FOOTER = /^\s*Enter to select\b.*\bEsc to cancel\b/;
const TAB_ROW = /^\s*(?:←\s+)?[☐☒✔]\s/;
const TAB = /([☐☒✔])\s+(.+?)(?=\s{2,}|\s*→|$)/g;
const REVIEW = /^\s*Review your answers\s*$/;
const SUBMIT_QUESTION = /^\s*Ready to submit your answers\?\s*$/;
const TYPE_SOMETHING = /^Type something\b/;
/** The dialog spans the screen: its rule starts at the left edge and its rows' numbers sit after the two-column cursor. */
const ROW_COLUMN = 2;

/** The tab row's questions in order, and which one is up: the first not yet answered, or Submit once all are. */
function stepOf(tabRow: string, review: boolean): PromptStep | undefined {
  const tabs = [...tabRow.matchAll(TAB)].map((match) => ({ mark: match[1] ?? "", title: (match[2] ?? "").trim() }));
  if (tabs.length < 2) return undefined;
  const open = tabs.findIndex((tab) => tab.mark === "☐");
  const index = review || open === -1 ? tabs.length : open + 1;
  return { index, count: tabs.length, titles: tabs.map((tab) => tab.title) };
}

/**
 * Claude Code's question dialog (AskUserQuestion), as 2.1.311 draws it:
 *
 *     ──────────────
 *     ←  ☐ Runtime  ☐ Deploy  ✔ Submit  →     (one tab per question; `☐ Database` alone for one question)
 *
 *     Which runtime should the service use?
 *
 *     ❯ 1. Bun                                  (`1. [ ] Lint` in a multi-select one: the number toggles the box)
 *          Bun 1.4
 *       2. Node
 *          Node 24
 *       3. Type something.                      (the cursor on it takes typed text)
 *     ──────────────
 *       4. Chat about this
 *
 *     Enter to select · Tab/Arrow keys to navigate · Esc to cancel
 *
 * A number answers its question and moves to the next one; → leaves a multi-select one for the next. Once every
 * question is answered it shows the answers under "Review your answers" and asks "Ready to submit your answers?".
 *
 * The question, its options' descriptions and the answers under review are the agent's own words, so it is read from
 * the bottom up: the footer, row 1 (the lowest one at the rows' column), and the tab row under the highest rule that
 * starts at the left edge. The agent's words never draw there: its lines above the dialog are indented under `●`, and
 * anything inside the dialog sits between that tab row and row 1, or under a row as its description (#776).
 */
export function readQuestion(lines: readonly string[]): Found | undefined {
  const end = lastIndex(lines, (line) => line.trim() !== "");
  const footerAt = QUESTION_FOOTER.test(lines[end] ?? "") ? end : -1;
  const firstRow = lastIndex(
    lines,
    (line) => optionRow(line)?.number === "1" && numberColumn(line) === ROW_COLUMN,
    end,
  );
  const tabAt = lines.findIndex(
    (line, index) => index > 0 && index < firstRow && TAB_ROW.test(line) && ruleAt(lines[index - 1] ?? "", 0, "─"),
  );
  if (firstRow === -1 || tabAt === -1) return undefined;
  const top = tabAt - 1;
  const dialog = lines.slice(tabAt + 1, firstRow);
  // A question ends on its footer; only the review, which has none, lists the answers. Question text that reads like a
  // review never makes the question one.
  const reviewAt = footerAt === -1 ? dialog.findIndex((line) => REVIEW.test(line)) : -1;
  const review = reviewAt !== -1;
  const questionAt = review
    ? dialog.findIndex((line) => SUBMIT_QUESTION.test(line))
    : dialog.findIndex((line) => line.trim() !== "");
  if (questionAt === -1 || (!review && footerAt === -1)) return undefined;
  const question = dialog
    .slice(questionAt)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
  const rows = detailedRows(lines.slice(firstRow, footerAt === -1 ? end + 1 : footerAt), false);
  const multi = rows.some((row) => CHECKBOX.test(row.label));
  const options = rows.flatMap((row): PromptOption[] => {
    const box = CHECKBOX.exec(row.label);
    const label = box?.[2] ?? row.label;
    const typed = TYPE_SOMETHING.test(label);
    // A multi-select dialog's typed row is a box too; its text cannot be checked from outside, so it is not offered.
    if (typed && multi) return [];
    return [
      option(
        { ...row, label },
        {
          declines: review && label === "Cancel",
          typed,
          ...(box === null ? {} : { checked: box[1] !== " " }),
        },
      ),
    ];
  });
  if (options.length === 0) return undefined;
  const step = stepOf(lines[tabAt] ?? "", review);
  const footer = footerAt === -1 ? "" : (lines[footerAt]?.trim() ?? "");
  const body = review ? bodyText(dialog.slice(reviewAt + 1, questionAt)) : "";
  const cursor = cursorOf(rows);
  const prompt: ScreenPrompt = {
    agent: AGENT,
    kind: "question",
    asks: review ? "asks to submit your answers" : "asks a question",
    question,
    command: question,
    body,
    context: contextAbove(lines, top, ASKED),
    files: [],
    multi,
    options,
    ...(multi ? { submit: "right" } : {}),
    ...(PERMISSION_FOOTER.test(footer) ? { cancel: CANCEL } : {}),
    ...(step === undefined ? {} : { step }),
    ...(cursor === undefined ? {} : { cursor, typing: options.some((row) => row.id === cursor && row.typed) }),
    block: [(lines[tabAt] ?? "").trim(), question, body, ...options.map(rowText), footer].join("\n"),
  };
  return { prompt, end };
}
