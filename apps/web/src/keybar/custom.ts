import { control, modifiedSequence } from "../terminal/keys.ts";

/**
 * What a person may type into a custom key: a chord ("Ctrl+X", "Alt+Shift+A", "F5", "PgUp") or, when no word names a
 * key, the text itself. Parsing is total and pure, and returns the bytes the terminal will receive rather than anything
 * that is evaluated later: a custom key can never run code.
 */

export interface ParsedKey {
  readonly bytes: string;
  /** The key as the settings show it, canonicalised from what was typed. */
  readonly label: string;
}

export type KeyInput =
  | { readonly kind: "ok"; readonly key: ParsedKey }
  | { readonly kind: "error"; readonly reason: string };

/** The longest literal text one key may send, so a stray paste cannot turn into a key that types a file. */
export const MAX_TEXT_BYTES = 64;

/** Named keys, in xterm's own sequences, as a hardware keyboard sends them. */
const NAMED: Readonly<Record<string, { readonly bytes: string; readonly label: string }>> = {
  esc: { bytes: "\u001b", label: "Esc" },
  escape: { bytes: "\u001b", label: "Esc" },
  tab: { bytes: "\t", label: "Tab" },
  enter: { bytes: "\r", label: "Enter" },
  return: { bytes: "\r", label: "Enter" },
  backspace: { bytes: "\u007f", label: "Backspace" },
  space: { bytes: " ", label: "Space" },
  home: { bytes: "\u001b[H", label: "Home" },
  end: { bytes: "\u001b[F", label: "End" },
  pgup: { bytes: "\u001b[5~", label: "PgUp" },
  pageup: { bytes: "\u001b[5~", label: "PgUp" },
  pgdn: { bytes: "\u001b[6~", label: "PgDn" },
  pagedown: { bytes: "\u001b[6~", label: "PgDn" },
  del: { bytes: "\u001b[3~", label: "Del" },
  delete: { bytes: "\u001b[3~", label: "Del" },
  ins: { bytes: "\u001b[2~", label: "Ins" },
  insert: { bytes: "\u001b[2~", label: "Ins" },
  up: { bytes: "\u001b[A", label: "↑" },
  down: { bytes: "\u001b[B", label: "↓" },
  right: { bytes: "\u001b[C", label: "→" },
  left: { bytes: "\u001b[D", label: "←" },
  f1: { bytes: "\u001bOP", label: "F1" },
  f2: { bytes: "\u001bOQ", label: "F2" },
  f3: { bytes: "\u001bOR", label: "F3" },
  f4: { bytes: "\u001bOS", label: "F4" },
  f5: { bytes: "\u001b[15~", label: "F5" },
  f6: { bytes: "\u001b[17~", label: "F6" },
  f7: { bytes: "\u001b[18~", label: "F7" },
  f8: { bytes: "\u001b[19~", label: "F8" },
  f9: { bytes: "\u001b[20~", label: "F9" },
  f10: { bytes: "\u001b[21~", label: "F10" },
  f11: { bytes: "\u001b[23~", label: "F11" },
  f12: { bytes: "\u001b[24~", label: "F12" },
};

type Modifier = "ctrl" | "alt" | "shift";

const MODIFIER_WORDS: Readonly<Record<string, Modifier>> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  opt: "alt",
  option: "alt",
  meta: "alt",
  cmd: "alt",
  command: "alt",
  super: "alt",
  shift: "shift",
};

const LABEL: Readonly<Record<Modifier, string>> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
const ORDER: readonly Modifier[] = ["ctrl", "alt", "shift"];
const NO_MODIFIERS: ReadonlySet<Modifier> = new Set<Modifier>();

function modifierOf(word: string): Modifier | undefined {
  return MODIFIER_WORDS[word.toLowerCase()];
}

function labelOf(modifiers: ReadonlySet<Modifier>, base: string): string {
  return [...ORDER.filter((modifier) => modifiers.has(modifier)).map((modifier) => LABEL[modifier]), base].join("+");
}

const refuse = (reason: string): KeyInput => ({ kind: "error", reason });

/**
 * One character (or one named key's bytes) with its modifiers. A modifier that changes nothing is refused rather than
 * dropped: a key labelled Ctrl+Tab that sends a plain Tab would be a lie.
 */
function typing(modifiers: ReadonlySet<Modifier>, base: string, label: string): KeyInput {
  const ctrl = modifiers.has("ctrl");
  const shift = modifiers.has("shift");
  const alt = modifiers.has("alt");
  if ((ctrl || shift) && [...base].length > 1) {
    return refuse(`${ctrl ? "Ctrl" : "Shift"} needs one key; it cannot apply to text.`);
  }
  const shifted = shift ? base.toUpperCase() : base;
  const controlled = ctrl ? control(shifted) : shifted;
  if (ctrl && controlled === shifted) return refuse(`Ctrl does not change ${label}.`);
  if (shift && shifted === base) return refuse(`Shift does not change ${label}.`);
  const bytes = alt ? `\u001b${controlled}` : controlled;
  if (bytes.length > MAX_TEXT_BYTES) return refuse(`A key sends at most ${MAX_TEXT_BYTES} characters.`);
  return { kind: "ok", key: { bytes, label: labelOf(modifiers, label) } };
}

function chord(modifiers: ReadonlySet<Modifier>, base: string, baseLabel: string): KeyInput {
  if (modifiers.size === 0) return { kind: "ok", key: { bytes: base, label: baseLabel } };
  if (baseLabel === "Tab" && modifiers.size === 1 && modifiers.has("shift")) {
    return { kind: "ok", key: { bytes: "\u001b[Z", label: "Shift+Tab" } };
  }
  const sequence = modifiedSequence(base, {
    ctrl: modifiers.has("ctrl"),
    shift: modifiers.has("shift"),
    meta: modifiers.has("alt"),
  });
  if (sequence !== null) {
    return { kind: "ok", key: { bytes: sequence, label: labelOf(modifiers, baseLabel) } };
  }
  return typing(modifiers, base, baseLabel);
}

/**
 * Reads one custom key. Only exact chord grammar (known modifier names, then one key) is a chord; anything else is the
 * literal text the key sends, so "git status" or "chmod +x" reach the terminal as typed. A bare modifier is the one
 * mistake refused here, since a key labelled Ctrl that sends the word Ctrl is not what anyone meant.
 */
export function parseKeyInput(input: string): KeyInput {
  const text = input.trim();
  if (text === "") return refuse("Type the keys this key sends.");
  if (modifierOf(text) !== undefined) {
    return refuse(`"${text}" on its own sends nothing; add the key it presses, e.g. ${text}+X.`);
  }
  const caret = /^\^(.)$/u.exec(text);
  if (caret !== null) return typing(new Set<Modifier>(["ctrl"]), caret[1] ?? "", caret[1] ?? "");
  // A plus at the very end is the key itself: "Ctrl++" is Ctrl and the plus sign.
  const parts = text.length > 2 && text.endsWith("++") ? [...text.slice(0, -2).split("+"), "+"] : text.split("+");
  const base = (parts[parts.length - 1] ?? "").trim();
  const modifiers = new Set<Modifier>();
  for (const head of parts.slice(0, -1)) {
    const modifier = modifierOf(head.trim());
    // A chord is exactly "known modifier names, then one key". Any other input is the literal text this key sends, so
    // "chmod +x", "date +%s", "echo $((2+3))" and even "Hyper+X" reach the terminal exactly as typed.
    if (modifier === undefined) return typing(NO_MODIFIERS, text, text);
    modifiers.add(modifier);
  }
  const named = NAMED[base.toLowerCase()];
  if (named !== undefined && modifiers.size === 0)
    return { kind: "ok", key: { bytes: named.bytes, label: named.label } };
  if (modifiers.size === 0) return typing(NO_MODIFIERS, text, text);
  if (base === "") return refuse("End the key with what it presses, e.g. Ctrl+X.");
  if (named !== undefined) return chord(modifiers, named.bytes, named.label);
  if ([...base].length === 1) {
    // A chord names a physical key, so Alt+X is option+x whatever case it was typed in; Shift still capitalises it.
    return typing(modifiers, base.toLowerCase(), base);
  }
  return refuse(`"${base}" is not a key. Name a letter, F1 to F12, Esc, Tab or an arrow.`);
}
