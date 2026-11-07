import { indent, lastIndex, numberColumn, type OptionRow, optionRow, type PromptOption } from "./approval-rows.ts";

export const AGENT = "Claude Code";
export const CANCEL = { key: "esc", label: "Cancel" } as const;
/** The person's own message in the transcript: where the agent's lines above a dialog start. */
export const ASKED = /^❯ /;
export const DIALOG_TOP = /^\s*─{10,}$/;
export const COMMAND_RULE = /^\s*╌{10,}$/;
export const CHECKBOX = /^\[(.)\]\s+(.*)$/;
export const PERMISSION_FOOTER = /\bEsc to cancel\b/;
/** How far below its question line a dialog's footer can be: its option rows, wrapped or not. */
export const DIALOG_ROWS = 16;

/** The first row above `at` that is not blank, or -1. */
export const aboveBlank = (lines: readonly string[], at: number) =>
  lastIndex(lines, (line) => line.trim() !== "", at - 1);
export const isNo = (label: string) => label === "No" || label.startsWith("No,");

/** The last line of the option list that starts at the first option row in `lines` and ends at a blank line, or -1. */
export function rowsEnd(lines: readonly string[]): number {
  const first = lines.findIndex((line) => optionRow(line) !== undefined);
  if (first === -1) return -1;
  const blank = lines.findIndex((line, index) => index > first && line.trim() === "");
  return blank === -1 ? lines.length - 1 : blank - 1;
}

/**
 * A question or plan dialog's option list: each numbered row, with the lines under it indented to its label as its
 * detail. Rules and lines indented less than the label (Claude's own Submit row) are not rows; a blank line ends it.
 * A row is drawn at the first row's number column and numbered one past the row above it: a line shaped like a row
 * anywhere else (inside a row's agent-written description) is that row's detail, never a row of its own (#776).
 */
export function detailedRows(
  lines: readonly string[],
  /** A blank line ends the list (a plan's rows); a question's rows run to its footer, past a description's blank line. */
  blankEnds = true,
): (OptionRow & { readonly detail?: string })[] {
  const rows: (OptionRow & { detail?: string })[] = [];
  /** Where each row's label starts: a line under it indented at least that far is its detail. */
  const columns: number[] = [];
  const first = lines.find((line) => optionRow(line) !== undefined);
  const rowColumn = first === undefined ? -1 : numberColumn(first);
  for (const line of lines) {
    const last = rows.at(-1);
    const next = last === undefined ? 1 : Number(last.number) + 1;
    const drawn = optionRow(line);
    const row =
      drawn !== undefined && numberColumn(line) === rowColumn && Number(drawn.number) === next ? drawn : undefined;
    if (row !== undefined) {
      const box = CHECKBOX.exec(row.label);
      rows.push(row);
      columns.push(line.length - (box?.[2] ?? row.label).length);
    } else if (last !== undefined && line.trim() === "") {
      if (blankEnds) break;
    } else if (last === undefined || DIALOG_TOP.test(line) || indent(line) < (columns.at(-1) ?? 0)) continue;
    else last.detail = last.detail === undefined ? line.trim() : `${last.detail} ${line.trim()}`;
  }
  return rows;
}

export function cursorOf(rows: readonly OptionRow[]): string | undefined {
  return rows.find((row) => row.cursor)?.number;
}

export function option(row: OptionRow & { readonly detail?: string }, more: Partial<PromptOption> = {}): PromptOption {
  return {
    id: row.number,
    label: row.label,
    ...(row.detail === undefined ? {} : { detail: row.detail }),
    keys: [row.number],
    open: [],
    declines: false,
    typed: false,
    ...more,
  };
}

export const rowText = (entry: PromptOption) =>
  [
    `${entry.id}. ${entry.checked === undefined ? "" : entry.checked ? "[x] " : "[ ] "}${entry.label}`,
    ...(entry.detail === undefined ? [] : [entry.detail]),
  ].join("\n");
