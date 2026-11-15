import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import {
  GA_AFTER_GA,
  HANGEUL,
  type Keyboard,
  keyThenSyllable,
  RETURN,
  safariReplace,
  SPACE,
  typeHangul,
} from "./hangul-edits.ts";
import { key, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE });

// The shell reads one line and prints its bytes in hex, run together and ended by a mark, so a jamo sent on its own,
// twice or out of order shows.
const READ_LINE = "IFS= read -r l; printf '%s' \"$l\" | od -An -tx1 | tr -d ' \\n'; echo :end\r";
// Two lines, each ended by its own mark, so what Return split them into shows.
const READ_TWO_LINES =
  "IFS= read -r l; printf '%s' \"$l\" | od -An -tx1 | tr -d ' \\n'; echo :end; IFS= read -r m; printf '%s' \"$m\" | od -An -tx1 | tr -d ' \\n'; echo :end2\r";

async function openReader(page: Page): Promise<{ readonly terminal: Locator; readonly field: Locator }> {
  const terminal = await openPhoneTerminal(page);
  await page.keyboard.type(READ_LINE);
  return { terminal, field: terminal.getByRole("textbox") };
}

/** Ends the line with the keyboard's Return and waits for the bytes the shell read. */
async function expectRead(page: Page, terminal: Locator, hex: string): Promise<void> {
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(new RegExp(`(^|\\s)${hex.replaceAll(" ", "")}:end`), {
    timeout: 10_000,
  });
}

for (const keyboard of ["iphone", "ipad"] satisfies Keyboard[]) {
  test(`${keyboard}: 한글 typed on the Korean keyboard reaches the program as two syllables, not jamo`, async ({
    page,
  }) => {
    const { terminal, field } = await openReader(page);
    await typeHangul(field, keyboard, HANGEUL);
    await expectRead(page, terminal, "ed 95 9c ea b8 80");
  });

  test(`${keyboard}: English, then Korean, then a space arrive once each and in order`, async ({ page }) => {
    const { terminal, field } = await openReader(page);
    await page.keyboard.type("abc");
    await typeHangul(field, keyboard, HANGEUL);
    await page.keyboard.type(" ");
    await expectRead(page, terminal, "61 62 63 ed 95 9c ea b8 80 20");
  });

  test(`${keyboard}: a final consonant that moves on to the next syllable is sent from where it ended (갑사)`, async ({
    page,
  }) => {
    const { terminal, field } = await openReader(page);
    await typeHangul(field, keyboard, [
      ["ㄱ", "ㄱ"],
      ["ㅏ", "가"],
      ["ㅂ", "갑"],
      ["ㅅ", "값"],
      ["ㅏ", "갑사"],
    ]);
    await expectRead(page, terminal, "ea b0 91 ec 82 ac");
  });

  test(`${keyboard}: Backspace inside a syllable takes back a jamo, not a character the program has`, async ({
    page,
  }) => {
    const { terminal, field } = await openReader(page);
    await page.keyboard.type("x");
    await typeHangul(field, keyboard, HANGEUL.slice(0, 3));
    // The keyboard's Backspace on 한: its keydown, then the editor takes the syllable back and puts 하 in its place.
    await field.evaluate((element) => {
      if (!(element instanceof HTMLTextAreaElement)) throw new Error("not a text field");
      const down = element.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Backspace",
          keyCode: 8,
        }),
      );
      if (!down) return;
      const end = element.selectionEnd;
      element.setRangeText("", end - 1, end, "end");
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      element.setRangeText("하", end - 1, end - 1, "end");
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "하" }));
    });
    await expectRead(page, terminal, "78 ed 95 98");
  });

  test(`${keyboard}: a space after a syllable lands in the field, so the next syllable starts fresh (#1508)`, async ({
    page,
  }) => {
    const { terminal, field } = await openReader(page);
    await typeHangul(field, keyboard, [
      ["ㄱ", "ㄱ"],
      ["ㅏ", "가"],
    ]);
    // A keyboard whose space never landed still holds 가: ㄱ joins it as 각, and ㅏ brings 가 back as 가가 over the space.
    expect(await keyThenSyllable(field, keyboard, SPACE, GA_AFTER_GA)).toBe(true);
    await expectRead(page, terminal, "ea b0 80 20 ea b0 80");
  });

  test(`${keyboard}: Return after a syllable lands in the field: the syllable, Return, then a fresh syllable (#1508)`, async ({
    page,
  }) => {
    const terminal = await openPhoneTerminal(page);
    await page.keyboard.type(READ_TWO_LINES);
    const field = terminal.getByRole("textbox");
    await typeHangul(field, keyboard, [
      ["ㄱ", "ㄱ"],
      ["ㅏ", "가"],
    ]);
    expect(await keyThenSyllable(field, keyboard, RETURN, GA_AFTER_GA)).toBe(true);
    await expect(terminal).toContainText(/(^|\s)eab080:end(\s|$)/, { timeout: 10_000 });
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText(/(^|\s)eab080:end2/, { timeout: 10_000 });
  });

  test(`${keyboard}: a key-bar key sends the syllable still being typed first`, async ({ page }) => {
    const { terminal, field } = await openReader(page);
    await typeHangul(field, keyboard, HANGEUL.slice(0, 3));
    await key(page, "Tab").click();
    await expectRead(page, terminal, "ed 95 9c 09");
  });
}

test("a paste the browser delivers only as input, while a syllable is still being typed, sends each part once", async ({
  page,
}) => {
  const { terminal, field } = await openReader(page);
  await typeHangul(field, "iphone", HANGEUL.slice(0, 4));
  // A browser that leaves clipboardData empty inserts the paste into the field itself.
  await field.evaluate((element) => {
    if (!(element instanceof HTMLTextAreaElement)) throw new Error("not a text field");
    const paste = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    });
    if (!element.dispatchEvent(paste)) return;
    element.setRangeText("xyz", element.selectionStart, element.selectionEnd, "end");
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: "xyz" }));
  });
  await expectRead(page, terminal, "ed 95 9c e3 84 b1 78 79 7a");
});

test("a paste inserted with no paste event, while a syllable is still being typed, sends each part once (#988)", async ({
  page,
}) => {
  const { terminal, field } = await openReader(page);
  await typeHangul(field, "iphone", HANGEUL.slice(0, 4));
  // No paste event first: the browser inserts the paste into the field and reports only the input.
  await field.evaluate((element) => {
    if (!(element instanceof HTMLTextAreaElement)) throw new Error("not a text field");
    element.setRangeText("xyz", element.selectionStart, element.selectionEnd, "end");
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: "xyz" }));
  });
  // The run ended with the paste: the next syllable starts afresh, with no stray erase of what was sent.
  await typeHangul(field, "iphone", HANGEUL.slice(0, 3));
  await expectRead(page, terminal, "ed 95 9c e3 84 b1 78 79 7a ed 95 9c");
});

test("iPad: Cmd+Backspace with a syllable still being typed kills the line with that syllable on it (#978)", async ({
  page,
}) => {
  const { terminal, field } = await openReader(page);
  await page.keyboard.type("x");
  await typeHangul(field, "ipad", HANGEUL.slice(0, 3));
  await field.evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Backspace",
        keyCode: 8,
        metaKey: true,
      }),
    );
  });
  // The kill took x and the syllable: nothing of either reaches the program after it.
  await page.keyboard.type("z");
  await expectRead(page, terminal, "7a");
});

test("Safari on a Mac: replacement edits without composition events reach the program as 한글", async ({ page }) => {
  const { terminal, field } = await openReader(page);
  await safariReplace(field, ["ㅎ", "하", "한"]);
  await safariReplace(field, ["ㄱ", "그", "글"]);
  await page.keyboard.type(" ");
  await expectRead(page, terminal, "ed 95 9c ea b8 80 20");
});

test("Safari on a Mac: a first jamo held longer than the lone-jamo wait still reaches the program only as its syllable (#1244)", async ({
  page,
}) => {
  const terminal = await openPhoneTerminal(page);
  // Raw mode, three bytes a row as they arrive: a jamo sent alone, and the erase that would take it back, reach the
  // program and show, where a line read would hide them behind the erase. dd ends at each third byte so od prints
  // then: the uutils od of ubuntu-26.04 keeps what it reads until more comes (#1952, as terminal-ime-commit's reader).
  await page.keyboard.type(
    "stty -icanon -echo min 1 time 0; echo RE''ADY; while :; do dd bs=1 count=3 2>/dev/null | od -An -tx1; done\r",
  );
  await expect(terminal.locator(".term-row").filter({ hasText: /^READY/ })).toHaveCount(1);
  const field = terminal.getByRole("textbox");
  // Safari's keydown comes after each edit; edits 150 ms apart outlast the 100 ms a lone jamo waits for a key.
  await safariReplace(field, ["ㅎ", "하", "한"], 150);
  await safariReplace(field, ["ㄱ", "그", "글"], 150);
  // A key after the last syllable sends it.
  await page.keyboard.type("x");
  const rows = terminal.locator(".term-row");
  const read = async (): Promise<string> => {
    const text = await rows.allTextContents();
    return text
      .slice(text.findIndex((row) => row.startsWith("READY")) + 1)
      .join(" ")
      .replaceAll(/\s+/g, " ")
      .trim();
  };
  await expect.poll(read, { timeout: 10_000 }).toContain("ea b8 80");
  const bytes = await read();
  expect(bytes, "no lone jamo reaches the program").not.toMatch(/e3 8[45] [0-9a-f]{2}/);
  expect(bytes, "no erase reaches the program").not.toMatch(/\b7f\b/);
  expect(bytes).toMatch(/^ed 95 9c ea b8 80\b/);
});
