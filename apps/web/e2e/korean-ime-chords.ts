/**
 * Ctrl+C and Ctrl+A pressed with a Korean input source active, idle and in the middle of the syllable 한, as each
 * browser delivers them to a page (#748).
 *
 * SYNTHETIC from the sources below, NOT a device recording: no real input method was driven to make these. A recorded
 * log from each platform replaces its entry when one is taken; the replay in korean-ime-ctrl-chord.e2e.ts reads only
 * this shape.
 *
 * - Chromium on macOS: while the input method has marked text, the keydown goes to the page with the Windows key code
 *   VKEY_PROCESSKEY (229) before the text the input method commits (content/app_shim_remote_cocoa/
 *   render_widget_host_view_cocoa.mm, `-keyEvent:wasKeyEquivalent:`, "To emulate Windows, over-write
 *   |event.windowsKeyCode| to VK_PROCESSKEY while an input method is composing"). The composition is still open
 *   then, so the keydown reads `isComposing: true`. `key` is the letter of the active layout (ㅊ for C, #652).
 * - Chromium on Windows: a key the input method processes is a VK_PROCESSKEY keydown, `key` "Process", keyCode 229
 *   (W3C UI Events, "Determine keydown and keyup keyCode", and its key value "Process"), ahead of the commit.
 * - Safari on macOS: WebKit fires compositionend before the keydown of the key that ended the composition, which then
 *   reads `isComposing: false` and keyCode 229 (WebKit bug 165004).
 * - Idle (nothing composing): the chord is an ordinary keydown with the key's own keyCode; on macOS `key` is still the
 *   Hangul letter (#652), on Windows the input method lets a Ctrl chord through as the Latin key.
 *
 * The mid-syllable entries type 한 with the 2-set layout first: ㅎ (G), ㅏ (K), ㄴ (S), each a keydown with keyCode 229,
 * the preedit growing, then the keyup with the key's own keyCode.
 */

export type ImeStep =
  | {
      readonly kind: "keydown" | "keyup";
      readonly key: string;
      readonly code: string;
      readonly keyCode: number;
      readonly ctrl: boolean;
    }
  | { readonly kind: "compose"; readonly text: string }
  | { readonly kind: "commit"; readonly text: string };

export interface ImeChord {
  readonly name: string;
  readonly steps: readonly ImeStep[];
  /** What the program reads, in order: the syllable (if one was composing) and then the chord's control byte. */
  readonly bytes: string;
}

type Platform = "macOS Chromium" | "macOS Safari" | "Windows Chromium";

const down = (key: string, code: string, keyCode: number, ctrl = false): ImeStep => ({
  kind: "keydown",
  key,
  code,
  keyCode,
  ctrl,
});
const up = (key: string, code: string, keyCode: number, ctrl = false): ImeStep => ({
  kind: "keyup",
  key,
  code,
  keyCode,
  ctrl,
});

/** 한 typed with the 2-set layout: three jamo, each a processed keydown and a growing preedit. */
const HAN: readonly ImeStep[] = [
  down("ㅎ", "KeyG", 229),
  { kind: "compose", text: "ㅎ" },
  up("ㅎ", "KeyG", 71),
  down("ㅏ", "KeyK", 229),
  { kind: "compose", text: "하" },
  up("ㅏ", "KeyK", 75),
  down("ㄴ", "KeyS", 229),
  { kind: "compose", text: "한" },
  up("ㄴ", "KeyS", 83),
];

const HAN_BYTES = "ed 95 9c";

interface Letter {
  readonly hangul: string;
  readonly latin: string;
  readonly code: string;
  readonly keyCode: number;
  readonly byte: string;
}

const LETTERS: readonly Letter[] = [
  { hangul: "ㅊ", latin: "c", code: "KeyC", keyCode: 67, byte: "03" },
  { hangul: "ㅁ", latin: "a", code: "KeyA", keyCode: 65, byte: "01" },
];

function idle(platform: Platform, letter: Letter): readonly ImeStep[] {
  const key = platform === "Windows Chromium" ? letter.latin : letter.hangul;
  return [down(key, letter.code, letter.keyCode, true), up(key, letter.code, letter.keyCode, true)];
}

function midSyllable(platform: Platform, letter: Letter): readonly ImeStep[] {
  const commit: ImeStep = { kind: "commit", text: "한" };
  const release = up(platform === "Windows Chromium" ? letter.latin : letter.hangul, letter.code, letter.keyCode, true);
  switch (platform) {
    case "macOS Chromium":
      return [...HAN, down(letter.hangul, letter.code, 229, true), commit, release];
    case "Windows Chromium":
      return [...HAN, down("Process", letter.code, 229, true), commit, release];
    case "macOS Safari":
      return [...HAN, commit, down(letter.hangul, letter.code, 229, true), release];
  }
}

const PLATFORMS: readonly Platform[] = ["macOS Chromium", "macOS Safari", "Windows Chromium"];

/** か typed with romaji input: k, then a, each a processed keydown and a growing preedit. */
const KA: readonly ImeStep[] = [
  down("k", "KeyK", 229),
  { kind: "compose", text: "k" },
  up("k", "KeyK", 75),
  down("a", "KeyA", 229),
  { kind: "compose", text: "か" },
  up("a", "KeyA", 65),
];

/**
 * A Japanese input method's own Ctrl+letter key turning か into カ while the word still composes, then Enter confirming
 * it: Ctrl+K on macOS (the Japanese input source's katakana key), Ctrl+I on Windows (Microsoft IME's full-width katakana
 * key, keydown `key` "Process"). The chord belongs to the input method: the program reads only カ. Synthetic, as above.
 */
function conversion(platform: Platform, key: string, code: string, keyCode: number): readonly ImeStep[] {
  const pressed = platform === "Windows Chromium" ? "Process" : key;
  return [
    ...KA,
    down(pressed, code, 229, true),
    { kind: "compose", text: "カ" },
    up(key, code, keyCode, true),
    down("Enter", "Enter", 229),
    { kind: "commit", text: "カ" },
    up("Enter", "Enter", 13),
  ];
}

export const JAPANESE_IME_CHORDS: readonly ImeChord[] = [
  {
    name: "macOS Chromium, Japanese: Ctrl+K mid-word",
    steps: conversion("macOS Chromium", "k", "KeyK", 75),
    bytes: "e3 82 ab",
  },
  {
    name: "Windows Chromium, Japanese: Ctrl+I mid-word",
    steps: conversion("Windows Chromium", "i", "KeyI", 73),
    bytes: "e3 82 ab",
  },
];

export const KOREAN_IME_CHORDS: readonly ImeChord[] = PLATFORMS.flatMap((platform) =>
  LETTERS.flatMap((letter) => [
    {
      name: `${platform}: Ctrl+${letter.latin.toUpperCase()} idle`,
      steps: idle(platform, letter),
      bytes: letter.byte,
    },
    {
      name: `${platform}: Ctrl+${letter.latin.toUpperCase()} mid-syllable`,
      steps: midSyllable(platform, letter),
      bytes: `${HAN_BYTES} ${letter.byte}`,
    },
  ]),
);
