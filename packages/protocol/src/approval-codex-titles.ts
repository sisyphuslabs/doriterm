// What Codex's TUI draws in an approval, from its source (codex-rs tui, upstream c3d3b142d1): every title, the header
// fields under it, the rows each kind of approval offers, and the cells drawn right above one. The card reads a Codex
// approval only when the screen fits these exactly (#776); approval-codex.ts reads it.

/** Rows `exec_options` draws for a command or input to a terminal (`bottom_pane/approval_overlay.rs`). */
const RUN_ROWS = [
  /^Yes, proceed$/, // :845
  /^Yes, and don't ask again for commands that start with `.*`$/, // :860
  /^Yes, and allow these permissions for this session$/, // :874
  /^Yes, and don't ask again for this command in this session$/, // :876
  /^No, continue without running it$/, // :907
  /^No, and tell Codex what to do differently$/, // :912
];
/** The same builder's rows when the command needs network access. */
const NETWORK_ROWS = [
  /^Yes, just this once$/, // :843
  /^Yes, and allow this host for this conversation$/, // :872
  /^Yes, and allow this host in the future$/, // :888
  /^No, and block this host in the future$/, // :892
  /^No, continue without running it$/, // :907
  /^No, and tell Codex what to do differently$/, // :912
];
const PATCH_ROWS = [
  /^Yes, proceed$/,
  /^Yes, and don't ask again for these files$/,
  /^No, and tell Codex what to do differently$/,
]; // :1018-1028
const PERMISSION_ROWS = [
  /^Yes, grant these permissions for this turn$/, // :1045
  /^Yes, grant for this turn with strict auto review$/, // :1050
  /^Yes, grant these permissions for this session$/, // :1057
  /^No, continue without permissions$/, // :1062
];
const ELICITATION_ROWS = [
  /^Yes, provide the requested info$/,
  /^No, but continue without it$/,
  /^Cancel this request$/,
]; // :1093-1103

export interface Title {
  readonly title: RegExp;
  readonly asks: string;
  /** The rows this kind's builder draws; undefined for a title not in the list, which any rows may follow. */
  readonly rows?: readonly RegExp[];
  /** A command (`$ …`) closes the header: only a command's approval, and only under the command's own cell. */
  readonly command?: true;
  /** The header ends in the server's own free message (`build_header` :781). */
  readonly message?: true;
}

/**
 * Every title `build_options` draws, the group being what it asks. The last entry is any other "Would you like to …?"
 * title, which the card read before these were listed, so no approval read then goes unread now.
 */
const TITLES: readonly Title[] = [
  { title: /^Would you like to (run the following command)\?$/, asks: "wants to run", rows: RUN_ROWS, command: true }, // :265
  { title: /^Would you like to (send input to the existing terminal)\?$/, asks: "asks for permission", rows: RUN_ROWS }, // :258
  { title: /^Would you like to (send input to terminal \S+)\?$/, asks: "asks for permission", rows: RUN_ROWS }, // :260
  { title: /^Do you want to (approve network access to ".+")\?$/, asks: "asks for permission", rows: NETWORK_ROWS }, // :268
  { title: /^Would you like to (grant these permissions)\?$/, asks: "asks for permission", rows: PERMISSION_ROWS }, // :286
  { title: /^Would you like to (make the following edits)\?$/, asks: "wants to edit", rows: PATCH_ROWS }, // :290
  { title: /^(\S.* needs your approval)\.$/, asks: "asks for permission", rows: ELICITATION_ROWS, message: true }, // :294
  { title: /^Would you like to (.+)\?$/, asks: "asks for permission" },
];

/** The title a line is, with what it asks; undefined for a line that is not one of Codex's approval titles. */
export function titleOf(line: string): (Title & { readonly asked: string }) | undefined {
  for (const entry of TITLES) {
    const asked = entry.title.exec(line.trim())?.[1];
    if (asked !== undefined) return { ...entry, asked };
  }
  return undefined;
}

/** The fields `build_header` draws (Thread :700, Environment :707, Reason :713, Permission rule :720, Input :727,
 * Server :779) and a patch's Description and Destination, as recorded. */
const FIELD = /^(?:Thread|Environment|Reason|Permission rule|Input|Server|Description|Destination): /;

/**
 * The cells drawn right above an approval: a command's `Running`, an exploring group's `Exploring`, input to a
 * terminal's `Interacted with` or `Waited for` (`exec_cell/render.rs`), a patch's `Added`, `Deleted` or `Edited`
 * (`diff_render.rs`), a tool call's `Calling` (`history_cell/mcp.rs`, `dynamic.rs`). A running cell blinks its bullet
 * between `•` and `◦` without true colour (`motion.rs`). A permissions request, input to a terminal and a user
 * verification draw no cell (`chatwidget/tool_requests.rs`). This is screen text: an agent message that opens with one
 * of these words draws the same line, so the header and the rows below must still fit the title on their own.
 */
export const ASKED_CELL = /^[•◦] (?:Running|Exploring|Interacted with|Waited for|Added|Deleted|Edited|Calling)(?:\s|$)/;
/** A line of the cell itself under its header: a command's `│`/`└` lines, a diff or a listing drawn four columns in. */
export const CELL_LINE = /^(?: {2}[│└]| {4})/;

/**
 * The lines from the title to the rows are this title's header: Codex's fields, a field's value wrapped onto the next
 * line, and blanks; a command's approval may end in its `$ …` command under the command's own cell, and an MCP
 * request in its server's message. Any other line (a wrapped or free-form title of a real dialog below) means the
 * title is not this dialog's.
 */
export function headerFits(header: readonly string[], title: Title, ownCell: boolean): boolean {
  for (const [index, line] of header.entries()) {
    const text = line.trim();
    if (text.startsWith("$ ")) return title.command === true && ownCell;
    const wrapped = index > 0 && (header[index - 1] ?? "").trim() !== "";
    if (text !== "" && !FIELD.test(text) && !wrapped && title.message !== true) return false;
  }
  return true;
}

/** The rows drawn are ones this title's builder draws: a title of another kind is not this dialog's. */
export function rowsFit(labels: readonly string[], title: Title): boolean {
  const rows = title.rows;
  return rows === undefined || labels.every((label) => rows.some((row) => row.test(label)));
}
