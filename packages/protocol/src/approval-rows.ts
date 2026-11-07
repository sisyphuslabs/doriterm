/** How an answer is recorded for clients that only know Allow and Deny: a decline (the agent's own No row, or its cancel), or any other choice. */
export type ApprovalAnswer = "allow" | "deny";

/** permission: run, edit or create something. question: the agent asks the person to choose. plan: approve a plan. */
export type PromptKind = "permission" | "question" | "plan";

/** One row of the agent's own option list, in its own words. */
export interface PromptOption {
  /** The row's number as the agent drew it. */
  readonly id: string;
  readonly label: string;
  /** The line the agent drew under or beside the row, if any. */
  readonly detail?: string;
  /**
   * The agent's own keys for the row, pressed as if typed, which pick it wherever the cursor sits (`2`, Codex's `y`).
   * Empty for a row only the cursor reaches: it is reached with ↑/↓ from where the cursor is on the live screen.
   */
  readonly keys: readonly string[];
  /** Keys pressed once the row is reached, before typing (Codex opens a row's notes with Tab). */
  readonly open: readonly string[];
  /** The agent's No row: choosing it is recorded as a decline. */
  readonly declines: boolean;
  /** The row takes a typed answer: once reached, the text is pasted and submitted with Enter. */
  readonly typed: boolean;
  /** A multi-select row's box, as checked on screen now. */
  readonly checked?: boolean;
}

/** One question of several the agent asks in a row; each is answered on its own, and the dialog moves to the next. */
export interface PromptStep {
  /** From 1. */
  readonly index: number;
  readonly count: number;
  /** The titles of the questions, as the agent's tab row or counter shows them; empty when it shows none. */
  readonly titles: readonly string[];
}

/** An interactive prompt as an agent drew it on its live screen. */
export interface ScreenPrompt {
  readonly agent: string;
  readonly kind: PromptKind;
  /** The agent's own verb phrase: "wants to run", "asks a question". */
  readonly asks: string;
  /** The dialog's own question line: "Do you want to proceed?". */
  readonly question: string;
  /** The exact command, file or question an answer applies to, whole. */
  readonly command: string;
  /** What the dialog shows besides: a diff, a file's new text, a plan, the answers it is about to submit. */
  readonly body: string;
  /** The agent's own lines above the dialog on the visible screen (what it is about to do and why), oldest first. */
  readonly context: readonly string[];
  /** Files the dialog names: the file an edit changes or creates, a plan's file. */
  readonly files: readonly string[];
  /** Several rows may be checked, then submitted with `submit`. */
  readonly multi: boolean;
  readonly options: readonly PromptOption[];
  /** A multi-select dialog's key that submits the checked rows. */
  readonly submit?: string;
  /** The dialog's own cancel key and the word its footer uses for it. */
  readonly cancel?: { readonly key: string; readonly label: string };
  readonly step?: PromptStep;
  /** The id of the row the cursor is on. */
  readonly cursor?: string;
  /** Text typed now goes into the cursor's row: a typed row is open for its answer. */
  readonly typing?: boolean;
  /** The dialog's text without the cursor glyph or rotating tips: what identifies this prompt on screen. */
  readonly block: string;
}

/** One agent's reader: the screen's lines, bottom row last, to the prompt it shows, if any. */
export type PromptReader = (lines: readonly string[]) => ScreenPrompt | undefined;

/** A dialog a reader found: its prompt and the row of its last line (its footer, or its last option row). */
export interface Found {
  readonly prompt: ScreenPrompt;
  readonly end: number;
}

export const indent = (line: string) => line.length - line.trimStart().length;

/** A rule of `char` drawn at exactly `column`: a dialog box's own border, never the text inside its padding. */
export const ruleAt = (line: string, column: number, char: "─" | "╌") =>
  indent(line) === column && line.trim().length >= 10 && [...line.trim()].every((each) => each === char);

/**
 * The dialog the agent is asking: the one whose last line is the screen's last line, since an agent draws its live
 * dialog at the bottom. Anything that only reads like a dialog ends above it: text the agent printed above the dialog,
 * or a command, diff, file or plan inside the dialog's own body that imitates another dialog (#776).
 */
export function liveDialog(lines: readonly string[], found: readonly (Found | undefined)[]): ScreenPrompt | undefined {
  const bottom = lastIndex(lines, (line) => line.trim() !== "");
  return found.find((each) => each !== undefined && each.end === bottom)?.prompt;
}

/** An option row such as `❯ 1. Yes` or `  3. No, and tell Codex what to do differently (esc)`, without its cursor. */
export interface OptionRow {
  readonly number: string;
  readonly label: string;
  /** The cursor glyph was on this row. */
  readonly cursor: boolean;
}

const OPTION = /^\s*([❯›>]\s*)?(\d+)\.\s+(.+)$/;

export function optionRow(line: string): OptionRow | undefined {
  const match = OPTION.exec(line);
  return match?.[2] === undefined || match[3] === undefined
    ? undefined
    : { number: match[2], label: match[3].trim(), cursor: match[1] !== undefined };
}

/** The column a numbered row's number is drawn at, or -1 for a line that is not one. */
export const numberColumn = (line: string) => {
  const row = optionRow(line);
  return row === undefined ? -1 : line.indexOf(`${row.number}.`);
};

/**
 * The option list that starts at the first option row in `lines` and ends at the first blank row. A row the agent
 * wrapped onto the next line (a narrow terminal) joins the option above it.
 */
export function optionRows(lines: readonly string[]): OptionRow[] {
  const rows: OptionRow[] = [];
  for (const line of lines) {
    const row = optionRow(line);
    const last = rows.at(-1);
    if (row !== undefined) rows.push(row);
    else if (last !== undefined && line.trim() === "") break;
    else if (last !== undefined) rows[rows.length - 1] = { ...last, label: `${last.label} ${line.trim()}` };
  }
  return rows;
}

/** The last row at or above `from` that `test` accepts, scanning up. */
export function lastIndex(
  lines: readonly string[],
  test: (line: string, index: number) => boolean,
  from = lines.length - 1,
): number {
  for (let index = from; index >= 0; index--) if (test(lines[index] ?? "", index)) return index;
  return -1;
}

/** How many of the agent's lines above a dialog the card shows, at most. */
const CONTEXT_LINES = 8;

/**
 * The agent's own lines between the person's last message (a row starting with `prompt`) and the dialog's first row:
 * what it said it is about to do. Blank rows and drawn rules are left out; only the last few are kept.
 */
export function contextAbove(lines: readonly string[], dialogTop: number, prompt: RegExp): string[] {
  const asked = lastIndex(lines, (line) => prompt.test(line), dialogTop - 1);
  return lines
    .slice(asked + 1, dialogTop)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^[─━╌▔▁]/.test(line))
    .slice(-CONTEXT_LINES);
}

/**
 * The prompt's text with every rule line dropped, the dialog's own indent taken off every line alike (a diff keeps its
 * columns) and runs of blank lines folded: what a card shows as its body.
 */
export function bodyText(lines: readonly string[]): string {
  const kept = lines.map((line) => line.trimEnd()).filter((line) => !/^\s*[─╌]{10,}$/.test(line));
  const margin = Math.min(...kept.filter((line) => line !== "").map((line) => line.length - line.trimStart().length));
  return kept
    .map((line) => line.slice(Number.isFinite(margin) ? margin : 0))
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}
