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

/** Safari on macOS: the first jamo inserted, each change replacing the syllable it changes, keydown 229 after it. */
export async function safariReplace(field: Locator, syllables: readonly string[]): Promise<void> {
  await field.evaluate(async (element, replacements) => {
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
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Unidentified",
          keyCode: 229,
        }),
      );
      box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified", keyCode: 229 }));
      // oxlint-disable-next-line no-await-in-loop -- one edit a frame, as a person types
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, syllables);
}

/** The steps of 한글 on a 2-set keyboard. */
export const HANGEUL: readonly (readonly [string, string])[] = [
  ["ㅎ", "ㅎ"],
  ["ㅏ", "하"],
  ["ㄴ", "한"],
  ["ㄱ", "한ㄱ"],
  ["ㅡ", "한그"],
  ["ㄹ", "한글"],
];

/**
 * One key of a Korean keyboard whose syllable state follows the field (a MODEL of the on-screen keyboard, not a recording):
 * the keyboard ends its syllable only when a key it sends reaches the field. A space whose keydown the page cancels never
 * reached it, so the keyboard's next jamo still joins the syllable before it: it takes that syllable back and puts the joined
 * one in its place. Returns whether the key's keydown was left to the field.
 */
export async function spaceThenJamo(
  field: Locator,
  keyboard: Keyboard,
  joined: { readonly jamo: string; readonly alone: string; readonly withPrevious: string },
): Promise<boolean> {
  const spaceDown = await field.evaluate((element) => {
    if (!(element instanceof HTMLTextAreaElement)) throw new Error("not a text field");
    const down = element.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: " ", keyCode: 32 }),
    );
    if (down) {
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: " " }));
      element.setRangeText(" ", element.selectionStart, element.selectionEnd, "end");
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: " " }));
    }
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: " ", keyCode: 32 }));
    return down;
  });
  await hangulKey(
    field,
    keyboard,
    joined.jamo,
    spaceDown ? [["insert", joined.alone]] : [["delete"], ["insert", joined.withPrevious]],
  );
  return spaceDown;
}
