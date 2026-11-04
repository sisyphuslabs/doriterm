/** Bytes for each key the phone's keys bar and arrow pad send. */
const SEQUENCES: Readonly<Record<string, string>> = {
  esc: "\u001b",
  tab: "\t",
  enter: "\r",
  backspace: "\u007f",
  // Form feed: the shell's clear-screen, as Ghostty's clear_screen sends it.
  clear: "\u000c",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
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

function control(char: string): string {
  if (char === " ") return "\u0000";
  if (char === "?") return "\u007f";
  const code = char.toUpperCase().charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code & 0x1f) : char;
}

/**
 * Applies the latched modifiers to one key or one piece of typed text. A terminal has no Cmd, so cmd reads as meta (an
 * ESC prefix), like alt, except in the host's paste chord.
 */
export function applyModifiers(data: string, latched: ReadonlySet<string>, host: HostPlatform): ModifiedInput {
  const ctrl = latched.has("ctrl");
  const shift = latched.has("shift");
  const meta = latched.has("alt") || latched.has("cmd");
  const chord = host === "mac" ? latched.has("cmd") : ctrl;
  if (chord && data.toLowerCase() === "v") return { kind: "paste" };
  const arrow = data.length === 3 && data.startsWith("\u001b[") && "ABCD".includes(data.charAt(2));
  if (arrow) {
    // xterm's modifier parameter: 1 + shift 1 + alt 2 + ctrl 4.
    const parameter = 1 + (shift ? 1 : 0) + (meta ? 2 : 0) + (ctrl ? 4 : 0);
    return { kind: "write", data: parameter === 1 ? data : `\u001b[1;${parameter}${data.charAt(2)}` };
  }
  let out = data;
  if (out === "\t" && shift) out = "\u001b[Z";
  else if (out.length === 1) {
    if (shift) out = out.toUpperCase();
    if (ctrl) out = control(out);
  }
  return { kind: "write", data: meta ? `\u001b${out}` : out };
}

/**
 * Whether a core runs on a mac, read from its name (the hostname by default: "Alexs-MacBook-Pro", "studio-mini",
 * "buildMac"), as hc reports no OS. A name that does not say mac reads as other.
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
