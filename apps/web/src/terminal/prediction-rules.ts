/**
 * The closed rule table that decides whether one input may be predicted (docs/design/remote-input-feel.md D4). A case
 * no row allows is not predicted. P8 (backspace pops an unconfirmed prediction) is an action of the predictor and P11
 * (scrolled away) a display gate of it; every other rule is a row here, checked in order, the first match refusing.
 */

/** The rule ids of the design note's table, as a verdict carries them. */
export type SuppressionRule = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8" | "P9" | "P10" | "P11" | "P12";

/** Where the input came from, tagged at the call site and never inferred from its length (P2). */
export type PredictionSource = "key" | "paste" | "automatic";

/** What the predictor sees in one input: one printable grapheme, a backspace, or anything else. */
export type InputShape =
  | { readonly kind: "grapheme"; readonly text: string; readonly codepoints: number }
  | { readonly kind: "backspace" }
  | { readonly kind: "other" };

/** Everything one row of the table reads, gathered once per input. */
export interface RuleContext {
  readonly source: PredictionSource;
  readonly observe: boolean;
  readonly linkReady: boolean;
  readonly composing: boolean;
  readonly altScreen: boolean;
  readonly frozen: boolean;
  readonly input: InputShape;
  /** A backspace would erase the last unconfirmed prediction, which the predicted cursor sits right after (P8). */
  readonly canPop: boolean;
  /** Cells the grapheme takes, by the terminal's own width table; undefined when not known or not one codepoint. */
  readonly width: number | undefined;
  /** Column the prediction would start at (the predicted cursor, else the real one). */
  readonly col: number;
  readonly cols: number;
}

interface SuppressionRow {
  readonly rule: SuppressionRule;
  readonly refuses: (context: RuleContext) => boolean;
  /**
   * The refused input still reaches the program and moves its cursor where the predictor cannot follow, so no new
   * prediction is made until a host write re-syncs it (P9). Input that is never typed (P10, P12) moves nothing.
   */
  readonly freezes: boolean;
}

const printable = (cell: number): boolean => cell >= 0x20 && !(cell >= 0x7f && cell <= 0x9f) && cell !== 0xfffd;

const knownWidth = (width: number | undefined): width is 1 | 2 => width === 1 || width === 2;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const decoder = new TextDecoder();

/**
 * Reads one input as the rules see it. Bytes are decoded as UTF-8; a malformed sequence decodes to U+FFFD and is not
 * printable here. A backspace is DEL or BS as sent, alone.
 */
export const decodeInput = (input: string | Uint8Array): string =>
  typeof input === "string" ? input : decoder.decode(input);

/**
 * The input submits a line: CR or LF anywhere in it (Enter, Ctrl-J, a pasted line), or Enter as the kitty keyboard
 * protocol encodes it (`CSI 13 u`, with or without modifiers).
 */
const KITTY_ENTER_AFTER_ESC = /^\[13(?:;[\d:]*)?u/;

export const submitsLine = (text: string): boolean =>
  text.includes("\r") ||
  text.includes("\n") ||
  text
    .split("\u001B")
    .slice(1)
    .some((sequence) => KITTY_ENTER_AFTER_ESC.test(sequence));

export function readInput(input: string | Uint8Array): InputShape {
  const text = decodeInput(input);
  if (text === "\u007F" || text === "\b") return { kind: "backspace" };
  const codepoints = [...text];
  if (codepoints.length === 0 || !codepoints.every((each) => printable(each.codePointAt(0) ?? 0))) {
    return { kind: "other" };
  }
  let graphemes = 0;
  for (const _ of segmenter.segment(text)) graphemes += 1;
  return graphemes === 1 ? { kind: "grapheme", text, codepoints: codepoints.length } : { kind: "other" };
}

/** The table, in the order it is checked: what never types, then link and screen state, then the input's shape. */
export const SUPPRESSION_TABLE: readonly SuppressionRow[] = [
  // P12: an observing stream never types; nothing it could send is a person's keystroke.
  { rule: "P12", refuses: (context) => context.observe, freezes: false },
  // P10: query answers the terminal writes itself (writeAutomatic) are never human typing.
  { rule: "P10", refuses: (context) => context.source === "automatic", freezes: false },
  // P2: a paste, even of one character, is tagged at its call site.
  { rule: "P2", refuses: (context) => context.source === "paste", freezes: true },
  // P6: no open stream, a link not yet proven after a wake, or input already queued: it would show as a long phantom.
  { rule: "P6", refuses: (context) => !context.linkReady, freezes: true },
  // P5: the preedit overlay already shows a composition in progress.
  { rule: "P5", refuses: (context) => context.composing, freezes: true },
  // P3: full-screen programs treat letters as commands.
  { rule: "P3", refuses: (context) => context.altScreen, freezes: true },
  // P9: after unpredicted input the cursor is unknown until the host writes again.
  { rule: "P9", refuses: (context) => context.frozen, freezes: true },
  // P1: only one printable grapheme is predicted; a backspace only when it can pop a prediction (P8).
  {
    rule: "P1",
    refuses: (context) => context.input.kind === "other" || (context.input.kind === "backspace" && !context.canPop),
    freezes: true,
  },
  // P7: one codepoint of a known width of one or two cells; a multi-codepoint grapheme (ZWJ emoji) is not predicted.
  {
    rule: "P7",
    refuses: (context) =>
      context.input.kind === "grapheme" && (context.input.codepoints !== 1 || !knownWidth(context.width)),
    freezes: true,
  },
  // P4: a prediction never reaches the last column, since the shell's wrap and the terminal's differ.
  {
    rule: "P4",
    refuses: (context) => context.input.kind === "grapheme" && context.col + (context.width ?? 1) > context.cols - 1,
    freezes: true,
  },
];

/** The first row that refuses the input, or null when it may be predicted (or, for a backspace, popped). */
export function suppressedBy(context: RuleContext): SuppressionRow | null {
  return SUPPRESSION_TABLE.find((row) => row.refuses(context)) ?? null;
}
