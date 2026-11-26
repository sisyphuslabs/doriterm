import { afterEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import type { KoreanLine, KeyUp } from "../../e2e/hangul-edits.ts";
import { KOREAN_LINES } from "../../e2e/korean-keyboard-lines.ts";

/**
 * The installed (patched) @wterm/dom InputHandler on a touch device, fed an iPhone Korean keyboard's events in each order
 * WebKit may deliver them (#2854). Its input.js is loaded by path, as in composition-cells.test.ts, and the handler is
 * built from its prototype around a stand-in field, so no DOM is needed: the field keeps its text with the caret at the
 * end, as the keyboard leaves it.
 */
const input = join(dirname(Bun.resolveSync("@wterm/dom", import.meta.dir)), "input.js");
const { InputHandler } = (await import(input)) as { InputHandler: { prototype: object } };

interface Key {
  readonly key: string;
  readonly keyCode: number;
}

interface Handler {
  handleKeyDown(event: object): void;
  handleKeyUp(event: object): void;
  handleInput(event: object): void;
  endKoreanKeyEdit?(): void;
  clearUnkeyedLetter(): void;
  textarea: { value: string };
}

const PLACEHOLDER = "\u200b";
const live: Handler[] = [];

afterEach(() => {
  for (const handler of live.splice(0)) {
    handler.endKoreanKeyEdit?.();
    handler.clearUnkeyedLetter();
  }
});

function touchHandler(sent: string[]): Handler {
  const fields = {
    composing: false,
    compositionWidth: 0,
    recentCompositionCommit: null,
    takenComposition: null,
    localSent: "",
    localPreedit: "",
    koreanKeyEdit: false,
    koreanKeyEditTimer: 0,
    unkeyedLetterTimer: 0,
    suppressNextTouchDeleteInput: false,
    focused: true,
    suppressedKeyUps: new Set<string>(),
    pressedModifiers: new Set<string>(),
    deliveredKeys: new Set<string>(),
    tabExitArmed: false,
    touchPrimary: true,
    element: { querySelector: () => null },
    textarea: { value: PLACEHOLDER, style: {}, scrollLeft: 0, scrollWidth: 0, setSelectionRange: () => undefined },
    onData: (data: string) => sent.push(data),
    getBridge: () => null,
    getCellSize: () => ({ charWidth: 8, rowHeight: 16 }),
  };
  const handler: Handler = Object.assign(Object.create(InputHandler.prototype), fields);
  live.push(handler);
  return handler;
}

/** A key event as WebKit gives the page: whether the page cancelled it is read back from `prevented`. */
function keyEvent({ key, keyCode }: Key): { prevented: boolean } {
  const event = {
    key,
    keyCode,
    code: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    prevented: false,
    getModifierState: () => false,
    preventDefault: () => {
      event.prevented = true;
    },
    stopPropagation: () => undefined,
  };
  return event;
}

/** The keyboard's edits from one shown word to the next: what changed is taken back, then put anew. */
function editsBetween(shown: string, after: string): (readonly ["delete"] | readonly ["insert", string])[] {
  const was = Array.from(shown);
  const now = Array.from(after);
  let kept = 0;
  while (kept < was.length && kept < now.length && was[kept] === now[kept]) kept += 1;
  return [...was.slice(kept).map(() => ["delete"] as const), ["insert", now.slice(kept).join("")] as const];
}

/** One key: keydown, the keyboard's field edits unless the keydown was cancelled, and the keyup where `keyUp` puts it. */
function press(handler: Handler, key: Key, edits: ReturnType<typeof editsBetween>, keyUp: KeyUp): boolean {
  const down = keyEvent(key);
  handler.handleKeyDown(down);
  const up = (): void => handler.handleKeyUp(keyEvent(key));
  let released = false;
  if (!down.prevented) {
    for (const [index, edit] of edits.entries()) {
      const last = edits.length - 1;
      if ((keyUp === "before-edits" && index === 0) || (keyUp === "between-edits" && index === last && last > 0)) {
        up();
        released = true;
      }
      const field = handler.textarea;
      if (edit[0] === "delete") {
        if (field.value === "") continue;
        field.value = Array.from(field.value).slice(0, -1).join("");
        handler.handleInput({ inputType: "deleteContentBackward", data: null });
      } else {
        field.value += edit[1];
        handler.handleInput({ inputType: "insertText", data: edit[1] });
      }
    }
  }
  if (!released) up();
  return !down.prevented;
}

/** What a line editor holds after `sent`: DEL takes back one character, Return ends the line. */
function lineOf(sent: readonly string[]): string {
  const line: string[] = [];
  for (const ch of sent.join("")) {
    if (ch === "\x7f") line.pop();
    else if (ch !== "\r") line.push(ch);
  }
  return line.join("");
}

interface Typed {
  readonly line: string;
  /** Spaces the page cancelled: the keyboard never saw them, so it goes on composing across them (#1508). */
  readonly cancelledSpaces: number;
  /** Erases sent: text the program got and had to give back, which a byte-erasing line editor leaves half of. */
  readonly erases: number;
}

function typeLine(line: KoreanLine, keyUp: KeyUp): Typed {
  const sent: string[] = [];
  const handler = touchHandler(sent);
  let cancelledSpaces = 0;
  for (const [index, word] of line.entries()) {
    if (index > 0 && !press(handler, { key: " ", keyCode: 32 }, [["insert", " "]], keyUp)) cancelledSpaces += 1;
    let shown = "";
    for (const [jamo, after] of word) {
      press(handler, { key: jamo, keyCode: 0 }, editsBetween(shown, after), keyUp);
      shown = after;
    }
  }
  press(handler, { key: "Enter", keyCode: 13 }, [], keyUp);
  return { line: lineOf(sent), cancelledSpaces, erases: sent.join("").split("\x7f").length - 1 };
}

const ORDERS = ["after-edits", "before-edits", "between-edits"] as const satisfies readonly KeyUp[];

for (const fixture of KOREAN_LINES) {
  test.each(ORDERS)(
    `iPhone ${fixture.keyboard}, keyup %s: ${fixture.name} (${fixture.text}) reaches the program as typed (#2854)`,
    (keyUp) => {
      expect(typeLine(fixture.line, keyUp)).toEqual({ line: fixture.text, cancelledSpaces: 0, erases: 0 });
    },
  );
}
