import type { HostOs } from "@doriface/protocol";
import { twoSetKey } from "./hangul-keys.ts";

/** Bytes for each key the phone's keys bar and arrow pad send. */
const SEQUENCES: Readonly<Record<string, string>> = {
  esc: "\u001b",
  // One tap for ^C, the key a phone keyboard has no way to type without latching Ctrl first (#673).
  interrupt: "\u0003",
  tab: "\t",
  enter: "\r",
  backspace: "\u007f",
  // Form feed: the shell's clear-screen, as Ghostty's clear_screen sends it.
  clear: "\u000c",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
  // xterm's own keys, so a key the person adds sends what a hardware keyboard sends.
  home: "\u001b[H",
  end: "\u001b[F",
  pageup: "\u001b[5~",
  pagedown: "\u001b[6~",
  delete: "\u001b[3~",
  tilde: "~",
  pipe: "|",
  slash: "/",
  dash: "-",
};

/** Sticky one-shot modifiers: each applies to the next key or typed character, then lets go. */
export const MODIFIERS: ReadonlySet<string> = new Set(["ctrl", "cmd", "shift", "alt"]);

export type HostPlatform = "mac" | "other";

export type ModifiedInput = { readonly kind: "write"; readonly data: string } | { readonly kind: "paste" };

export function keySequence(id: string): string | undefined {
  return SEQUENCES[id];
}

export function control(char: string): string {
  if (char === " ") return "\u0000";
  if (char === "?") return "\u007f";
  const code = char.toUpperCase().charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code & 0x1f) : char;
}

const ESC = "\u001b";

/** The keys a bar can send as `\e[<number>~`: Insert, Delete, the pages, and F5 to F12. */
const NUMBERED_KEYS: ReadonlySet<string> = new Set([
  "1",
  "2",
  "3",
  "5",
  "6",
  "15",
  "17",
  "18",
  "19",
  "20",
  "21",
  "23",
  "24",
]);

/** The keys a bar can send as `\e[<letter>`: the arrows, Home and End. */
const LETTER_KEYS: ReadonlySet<string> = new Set(["A", "B", "C", "D", "F", "H"]);

export interface SequenceModifiers {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

/** xterm's modifier parameter: 1 + Shift 1 + Alt 2 + Ctrl 4. */
function sequenceParameter(modifiers: SequenceModifiers): number {
  return 1 + (modifiers.shift ? 1 : 0) + (modifiers.meta ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
}

/**
 * The modified form of a key whose plain bytes are an xterm sequence: `\e[5~` with Ctrl is `\e[5;5~`, `\e[H` with Ctrl
 * is `\e[1;5H`. Only the sequences a key bar can send are rewritten, so a focus report (`\e[I`) or a status report
 * (`\e[0n`) that arrives while a modifier is latched passes through untouched. Null means "type it as before".
 */
export function modifiedSequence(bytes: string, modifiers: SequenceModifiers): string | null {
  if (!bytes.startsWith(ESC)) return null;
  const rest = bytes.slice(1);
  const final = rest.slice(-1);
  if (rest.startsWith("[")) {
    const body = rest.slice(1, -1);
    if (!/^\d*$/u.test(body)) return null;
    if (final === "~" && NUMBERED_KEYS.has(body)) return `${ESC}[${body};${sequenceParameter(modifiers)}~`;
    if (body === "" && LETTER_KEYS.has(final)) return `${ESC}[1;${sequenceParameter(modifiers)}${final}`;
    return null;
  }
  if (rest.startsWith("O") && rest.length === 2 && "PQRS".includes(final)) {
    return `${ESC}[1;${sequenceParameter(modifiers)}${final}`;
  }
  return null;
}

/**
 * Applies the latched modifiers to one key or one piece of typed text. A terminal has no Cmd, so cmd reads as meta (an
 * ESC prefix), like alt. ctrl+v stays ^V on every host (vim's visual block, a shell's quoted insert); the paste chord
 * is cmd+v on a mac host and ctrl+shift+v elsewhere, so a wrong guess of the host only moves the Cmd key.
 */
export function applyModifiers(typed: string, latched: ReadonlySet<string>, host: HostPlatform): ModifiedInput {
  const ctrl = latched.has("ctrl");
  const shift = latched.has("shift");
  const meta = latched.has("alt") || latched.has("cmd");
  // With a chord latched, a Hangul letter from a Korean keyboard reads as the key it sits on: ctrl+ㅊ is ^C.
  const data = ctrl || meta ? (twoSetKey(typed) ?? typed) : typed;
  const chord = host === "mac" ? latched.has("cmd") : ctrl && shift;
  if (chord && data.toLowerCase() === "v") return { kind: "paste" };
  const sequence = modifiedSequence(data, { ctrl, shift, meta });
  if (sequence !== null) return { kind: "write", data: ctrl || shift || meta ? sequence : data };
  let out = data;
  if (out === "\t" && shift) out = "\u001b[Z";
  else if (out.length === 1) {
    if (shift) out = out.toUpperCase();
    if (ctrl) out = control(out);
  }
  return { kind: "write", data: meta ? `\u001b${out}` : out };
}

/**
 * Whether a core runs on a mac, guessed from its name (the hostname by default: "Alexs-MacBook-Pro", "studio-mini",
 * "buildMac") for a host too old to report its OS (see `platformOf`). A name that does not say mac reads as other.
 */
export function hostPlatform(coreName: string): HostPlatform {
  const words = coreName
    .split(/[^A-Za-z0-9]+/)
    .flatMap((word) => word.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((word) => word.toLowerCase());
  return words.some((word) => word === "mac" || word === "macbook" || word === "imac" || word === "darwin")
    ? "mac"
    : "other";
}

/**
 * The key bar's platform for a terminal's host: what the host reported on its core when it did, else the guess from
 * the core's or machine's name (an older host writes no OS).
 */
export const platformOf = (os: HostOs | undefined, name: string): HostPlatform =>
  os === undefined ? hostPlatform(name) : os === "darwin" ? "mac" : "other";
