import { expect, test } from "bun:test";
import { dirname, join } from "node:path";

/**
 * What the installed (patched) @wterm/dom sends for a WebKit Korean keyboard's run, which it keeps in the field and
 * edits there with no composition events (#1944). Its input.js is loaded by path, as in composition-cells.test.ts, and
 * the handler's methods run on a stand-in with a stand-in field, so no DOM is needed.
 */
const input = join(dirname(Bun.resolveSync("@wterm/dom", import.meta.dir)), "input.js");
const { InputHandler } = (await import(input)) as { InputHandler: { prototype: object } };

interface Bridge {
  kittyKeyboardFlags(): number;
  cursorKeysApp(): boolean;
}

interface Handler {
  localSent: string;
  localPreedit: string;
  koreanKeyEdit: boolean;
  textarea: { value: string };
  editLocalRun(value: string): void;
  handleInput(e: object): void;
  handleKeyDown(e: object): void;
}

function handler(kittyFlags = 0, overrides: object = {}): { run: Handler; sent: string[] } {
  const sent: string[] = [];
  const bridge: Bridge = { kittyKeyboardFlags: () => kittyFlags, cursorKeysApp: () => false };
  const run = Object.assign(Object.create(InputHandler.prototype) as Handler, {
    localSent: "",
    localPreedit: "",
    koreanKeyEdit: false,
    localKeyed: false,
    recentCompositionCommit: null,
    composing: false,
    touchPrimary: false,
    unkeyedLetterTimer: 0,
    suppressedKeyUps: new Set(),
    pressedModifiers: new Set(),
    deliveredKeys: new Set(),
    element: { querySelector: () => null },
    textarea: { value: "", style: {}, scrollLeft: 0, scrollWidth: 0 },
    onData: (data: string) => sent.push(data),
    getBridge: () => bridge,
    getCellSize: () => null,
    ...overrides,
  });
  return { run, sent };
}

function keyDown(
  key: string,
  shiftKey: boolean,
  keyCode = key === " " ? 32 : 13,
): {
  event: object;
  cancelled: () => boolean;
} {
  let cancelled = false;
  const event = {
    key,
    code: key === " " ? "Space" : key,
    shiftKey,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    keyCode,
    repeat: false,
    getModifierState: () => false,
    preventDefault: () => {
      cancelled = true;
    },
    stopPropagation: () => {},
  };
  return { event, cancelled: () => cancelled };
}

test.each([
  ["a space", "\u{AC00} ", " "],
  ["Return", "\u{AC00}\n", "\r"],
] as const)("a run ended by %s sends its text, then the key itself (#1944)", (_name, field, key) => {
  const { run, sent } = handler();
  run.editLocalRun(field);
  expect(sent).toEqual(["\u{AC00}", key]);
});

test.each([
  ["a space, with the program reporting every key", "\u{AC00} ", 8, "\x1b[32u"],
  ["Return, with the program disambiguating keys", "\u{AC00}\n", 1, "\r"],
] as const)("the key that ends a run is %s encoded in the program's keyboard mode (#1944)", (_n, field, flags, key) => {
  const { run, sent } = handler(flags);
  run.editLocalRun(field);
  expect(sent).toEqual(["\u{AC00}", key]);
});

test("a key the keyboard mode has no sequence for sends only the text (#1944)", () => {
  const { run, sent } = handler(0, { encodeKey: () => null });
  run.editLocalRun("\u{AC00} ");
  expect(sent).toEqual(["\u{AC00}"]);
});

test.each([
  ["the next syllable is typed", "\u{AC00} \u{AE30}", "\u{AE30}"],
  ["the jamo is taken back", "\u{AC00} ", ""],
] as const)("the key that ended a run is sent once when a jamo followed it and %s (#1944)", (_name, next, preedit) => {
  const { run, sent } = handler();
  run.editLocalRun("\u{AC00} \u{3131}");
  run.editLocalRun(next);
  expect(sent).toEqual(["\u{AC00}", " "]);
  expect(run.localPreedit).toBe(preedit);
});

test.each([
  ["Return", "Enter", 0, "\x1b[13;2u"],
  ["space", " ", 8, "\x1b[32;2u"],
] as const)(
  "Shift+%s with a syllable open is the key, not the field's edit, and keeps its Shift (#1944)",
  (_n, key, flags, seq) => {
    const { run, sent } = handler(flags);
    run.localPreedit = "\u{AC00}";
    const { event, cancelled } = keyDown(key, true);
    run.handleKeyDown(event);
    expect(sent).toEqual(["\u{AC00}", seq]);
    expect(cancelled()).toBe(true);
    expect(run.koreanKeyEdit).toBe(false);
  },
);

/** The field holding `value` after an edit, as handleInput reads it. */
function edit(run: Handler, value: string): void {
  run.textarea.value = value;
  run.handleInput({ inputType: "insertText" });
}

// Safari on macOS, as recorded (korean-ime-recorded.ts): each jamo's edit, then its keydown reading 229; the input method
// has ended the syllable before the space or Return's own keydown, which carries no edit of the field after it (#1944).
test.each([
  ["Return", "Enter", "\r"],
  ["a space", " ", " "],
] as const)(
  "%s after a syllable Safari on a Mac typed is the key: the syllable, then the key (#1944)",
  (_n, key, seq) => {
    const { run, sent } = handler();
    edit(run, "\u{3131}");
    run.handleKeyDown(keyDown("\u{3131}", false, 229).event);
    edit(run, "\u{AC00}");
    run.handleKeyDown(keyDown("\u{314F}", false, 229).event);
    const { event, cancelled } = keyDown(key, false);
    run.handleKeyDown(event);
    expect(sent).toEqual(["\u{AC00}", seq]);
    expect(cancelled()).toBe(true);
  },
);

// An iPhone or iPad keyboard names each jamo in a keydown before its edit, and ends its syllable only when its own key
// lands in the field: that key stays the field's edit.
test("Return after a syllable an on-screen keyboard keyed is left to the field (#1944)", () => {
  const { run, sent } = handler();
  run.handleKeyDown(keyDown("\u{3131}", false, 0).event);
  edit(run, "\u{3131}");
  run.handleKeyDown(keyDown("\u{314F}", false, 0).event);
  edit(run, "\u{AC00}");
  const { event, cancelled } = keyDown("Enter", false);
  run.handleKeyDown(event);
  expect(sent).toEqual([]);
  expect(cancelled()).toBe(false);
  edit(run, "\u{AC00}\n");
  expect(sent).toEqual(["\u{AC00}", "\r"]);
});
