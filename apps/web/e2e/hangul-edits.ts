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

/**
 * Where a key's keyup lands among the editor's edits it makes. WebKit sends the key's events and the input method's edits
 * separately, so on a phone the keyup can come before them, or between a syllable's deletion and its replacement (#2854).
 */
export type KeyUp = "after-edits" | "before-edits" | "between-edits";

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
  keyUp: KeyUp = "after-edits",
): Promise<void> {
  const keyCode = keyboard === "iphone" ? 0 : (KEY_CODES[jamo] ?? 65);
  await field.evaluate(
    async (element, key) => {
      const { edits: steps } = key;
      const last = steps.length - 1;
      const upBefore = (index: number): boolean =>
        (key.keyUp === "before-edits" && index === 0) || (key.keyUp === "between-edits" && index === last && last > 0);
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
      let up = false;
      const keyUpEvent = (): void => {
        up = true;
        box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: key.jamo, keyCode: key.keyCode }));
      };
      if (down && press) {
        for (const [index, edit] of steps.entries()) {
          if (upBefore(index)) keyUpEvent();
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
      if (!up) keyUpEvent();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    },
    { jamo, keyCode, edits, keyUp },
  );
}

/** The editor's edits from one shown text to the next: what changed is taken back from where it starts, then put anew. */
function editsBetween(shown: string, after: string): Edit[] {
  const was = Array.from(shown);
  const now = Array.from(after);
  let kept = 0;
  while (kept < was.length && kept < now.length && was[kept] === now[kept]) kept += 1;
  const deletes = was.slice(kept).map((): Edit => ["delete"]);
  return [...deletes, ["insert", now.slice(kept).join("")]];
}

/** Types `steps` as a WebKit Korean keyboard does: each step is a jamo and the syllables before the caret after it. */
export async function typeHangul(
  field: Locator,
  keyboard: Keyboard,
  steps: readonly (readonly [jamo: string, after: string])[],
  keyUp?: KeyUp,
  /** The syllable already in the field that the first step goes on from (a jamo another helper typed). */
  from = "",
): Promise<void> {
  let shown = from;
  for (const [jamo, after] of steps) {
    // oxlint-disable-next-line no-await-in-loop -- each key edits the field the previous one left
    await hangulKey(field, keyboard, jamo, editsBetween(shown, after), keyUp);
    shown = after;
  }
}

/** A line of words typed on a phone's Korean keyboard: each word's steps as `typeHangul` takes them, a space between. */
export type KoreanLine = readonly (readonly (readonly [key: string, after: string])[])[];

/**
 * Types `line` with the keyboard's own space between its words, and returns how many of those spaces the page cancelled.
 * A cancelled space never reaches the keyboard's field, so the keyboard would go on composing across it (#1508).
 */
export async function typeKoreanLine(
  field: Locator,
  keyboard: Keyboard,
  line: KoreanLine,
  keyUp?: KeyUp,
): Promise<number> {
  let cancelled = 0;
  for (const [index, word] of line.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- each word follows the space before it
    if (index > 0 && !(await spaceKey(field))) cancelled += 1;
    // oxlint-disable-next-line no-await-in-loop -- each key edits the field the previous one left
    await typeHangul(field, keyboard, word, keyUp);
  }
  return cancelled;
}

/** The keyboard's space: its keydown, and the space it puts in the field unless the page cancelled the keydown. */
async function spaceKey(field: Locator): Promise<boolean> {
  return field.evaluate((element) => {
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
  const spaceDown = await spaceKey(field);
  await hangulKey(
    field,
    keyboard,
    joined.jamo,
    spaceDown ? [["insert", joined.alone]] : [["delete"], ["insert", joined.withPrevious]],
  );
  return spaceDown;
}
