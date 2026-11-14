import type { Locator } from "@playwright/test";

/**
 * WebKit's Korean keyboards edit the field as plain text, with no composition events (traces recorded by Ovis,
 * github.com/devswha/ovis, MIT: scripts/terminal-ipad-ime-regression.ts and terminal-safari-ime-regression.ts):
 *
 * - iPhone on-screen keyboard (keyCode 0) and iPad with a hardware keyboard (the key's own keyCode): a keydown naming
 *   the jamo, a keypress, then the editor's edits: a new syllable is an insertText of the jamo, a changed one is a
 *   deleteContentBackward and an insertText of the whole result, caret-relative.
 * - Safari on macOS (26.x): insertText of the first jamo, then insertReplacementText of the changed syllable over it,
 *   with the keydown (keyCode 229) arriving after each edit.
 *
 * A cancelled keydown means the editor makes no edit, as WebKit does.
 */
export type Edit = readonly ["delete"] | readonly ["insert", string];

export type Keyboard = "iphone" | "ipad";

const KEY_CODES: Readonly<Record<string, number>> = {
  ㅎ: 71,
  ㅏ: 75,
  ㄴ: 83,
  ㄱ: 82,
  ㅡ: 77,
  ㄹ: 70,
  ㅂ: 81,
  ㅅ: 84,
  ㅁ: 65,
  ㅇ: 68,
};

/** One key of an iPhone or iPad Korean keyboard: its keydown and keypress, then the editor's own edits. */
export async function hangulKey(
  field: Locator,
  keyboard: Keyboard,
  jamo: string,
  edits: readonly Edit[],
): Promise<void> {
  const keyCode = keyboard === "iphone" ? 0 : (KEY_CODES[jamo] ?? 65);
  await field.evaluate(
    async (element, key) => {
      const { edits: steps } = key;
      if (!(element instanceof HTMLTextAreaElement)) throw new Error("not a text field");
      const box = element;
      const down = box.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: key.jamo,
          keyCode: key.keyCode,
        }),
      );
      const code = key.jamo.charCodeAt(0);
      const press =
        down &&
        box.dispatchEvent(
          new KeyboardEvent("keypress", {
            bubbles: true,
            cancelable: true,
            key: key.jamo,
            keyCode: code,
            charCode: code,
          }),
        );
      if (down && press) {
        for (const edit of steps) {
          if (edit[0] === "delete") {
            const end = box.selectionEnd;
            const start = box.selectionStart === end ? Math.max(0, end - 1) : box.selectionStart;
            box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "deleteContentBackward" }));
            box.setRangeText("", start, end, "end");
            box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
          } else {
            const data = edit[1];
            box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data }));
            box.setRangeText(data, box.selectionStart, box.selectionEnd, "end");
            box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data }));
          }
        }
      }
      box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: key.jamo, keyCode: key.keyCode }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    },
    { jamo, keyCode, edits },
  );
}

/** Types `steps` as a WebKit Korean keyboard does: each step is a jamo and the syllables before the caret after it. */
export async function typeHangul(
  field: Locator,
  keyboard: Keyboard,
  steps: readonly (readonly [jamo: string, after: string])[],
): Promise<void> {
  let shown = "";
  for (const [jamo, after] of steps) {
    // A key that only adds a syllable inserts its jamo; one that changes the last syllable takes it back and puts the
    // new text in its place.
    const kept = shown.slice(0, -1);
    const edits: Edit[] =
      after === shown + jamo ? [["insert", jamo]] : [["delete"], ["insert", after.slice(kept.length)]];
    // oxlint-disable-next-line no-await-in-loop -- each key edits the field the previous one left
    await hangulKey(field, keyboard, jamo, edits);
    shown = after;
  }
}

/**
 * Safari on macOS: the first jamo inserted, each change replacing the syllable it changes, keydown 229 after it. One
 * edit a frame, or `pauseMs` apart, as a slower typist leaves them.
 */
export async function safariReplace(field: Locator, syllables: readonly string[], pauseMs?: number): Promise<void> {
  await field.evaluate(
    async (element, { replacements, pause }) => {
      if (!(element instanceof HTMLTextAreaElement)) throw new Error("not a text field");
      const box = element;
      const at = box.selectionEnd;
      for (const [index, data] of replacements.entries()) {
        const inputType = index === 0 ? "insertText" : "insertReplacementText";
        const end = index === 0 ? at : Math.min(box.value.length, at + 1);
        box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType, data }));
        box.setRangeText(data, Math.min(at, box.value.length), end, "end");
        box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
        box.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Unidentified", keyCode: 229 }),
        );
        box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified", keyCode: 229 }));
        // oxlint-disable-next-line no-await-in-loop -- one edit after another, as a person types
        await new Promise<void>((resolve) => {
          if (pause === undefined) requestAnimationFrame(() => resolve());
          else setTimeout(resolve, pause);
        });
      }
    },
    { replacements: syllables, pause: pauseMs },
  );
}

/** A key an on-screen Korean keyboard ends a syllable with, and what it writes into the field when left to it. */
export interface EndingKey {
  readonly key: " " | "Enter";
  readonly keyCode: 32 | 13;
  readonly inserts: " " | "\n";
  readonly inputType: "insertText" | "insertLineBreak";
}

export const SPACE: EndingKey = { key: " ", keyCode: 32, inserts: " ", inputType: "insertText" };
export const RETURN: EndingKey = { key: "Enter", keyCode: 13, inserts: "\n", inputType: "insertLineBreak" };

/** The syllable typed after an ending key: its first jamo, its vowel, and the result with and without the join. */
export interface NextSyllable {
  readonly jamo: string;
  readonly vowel: string;
  /** The syllable on its own, as the keyboard writes it once its previous syllable has ended. */
  readonly alone: string;
  /** The previous syllable with the jamo joined to it, as the keyboard writes it when that syllable is still open. */
  readonly joined: string;
  /** The two syllables the vowel then makes out of the joined one (the final consonant moves on). */
  readonly split: string;
}

/**
 * A MODEL of the on-screen keyboard, not a recording: its syllable ends only when a key of its own reaches the field.
 * The ending key's keydown, then the field's edit when the key was left to it; then the next syllable. When the key
 * landed, the keyboard starts that syllable fresh. When the page cancelled the key, the keyboard still holds the previous
 * syllable: its jamo joins it (the syllable is taken back and the joined one put in its place), and the vowel then splits
 * the joined one into two syllables, so the previous syllable comes back on the screen a second time (#1508).
 * Returns whether the ending key's keydown was left to the field.
 */
export async function keyThenSyllable(
  field: Locator,
  keyboard: Keyboard,
  ending: EndingKey,
  next: NextSyllable,
): Promise<boolean> {
  const landed = await field.evaluate((element, key) => {
    if (!(element instanceof HTMLTextAreaElement)) throw new Error("not a text field");
    const box = element;
    const down = box.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: key.key, keyCode: key.keyCode }),
    );
    if (down) {
      box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: key.inputType, data: key.inserts }));
      box.setRangeText(key.inserts, box.selectionStart, box.selectionEnd, "end");
      box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: key.inputType, data: key.inserts }));
    }
    box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: key.key, keyCode: key.keyCode }));
    return down;
  }, ending);
  if (landed) {
    await hangulKey(field, keyboard, next.jamo, [["insert", next.jamo]]);
    await hangulKey(field, keyboard, next.vowel, [["delete"], ["insert", next.alone]]);
  } else {
    await hangulKey(field, keyboard, next.jamo, [["delete"], ["insert", next.joined]]);
    await hangulKey(field, keyboard, next.vowel, [["delete"], ["insert", next.split]]);
  }
  return landed;
}

/** 가 typed after 가: ㄱ joins an open 가 as 각, and ㅏ then splits 각 into 가가. */
export const GA_AFTER_GA: NextSyllable = { jamo: "ㄱ", vowel: "ㅏ", alone: "가", joined: "각", split: "가가" };

/** The steps of 한글 on a 2-set keyboard. */
export const HANGEUL: readonly (readonly [string, string])[] = [
  ["ㅎ", "ㅎ"],
  ["ㅏ", "하"],
  ["ㄴ", "한"],
  ["ㄱ", "한ㄱ"],
  ["ㅡ", "한그"],
  ["ㄹ", "한글"],
];
