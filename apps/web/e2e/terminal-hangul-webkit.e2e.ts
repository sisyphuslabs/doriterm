import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { HANGEUL, type Keyboard, safariReplace, typeHangul } from "./hangul-edits.ts";
import { key, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE });

// The shell reads one line and prints its bytes in hex, run together and ended by a mark, so a jamo sent on its own,
// twice or out of order shows.
const READ_LINE = "IFS= read -r l; printf '%s' \"$l\" | od -An -tx1 | tr -d ' \\n'; echo :end\r";

async function openReader(page: Page): Promise<{ readonly terminal: Locator; readonly field: Locator }> {
  const terminal = await openPhoneTerminal(page);
  await page.keyboard.type(READ_LINE);
  return { terminal, field: terminal.getByRole("textbox") };
}

/** Ends the line with the keyboard's Return and waits for the bytes the shell read. */
async function expectRead(page: Page, terminal: Locator, hex: string): Promise<void> {
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(new RegExp(`(^|\\s)${hex.replaceAll(" ", "")}:end`), { timeout: 10_000 });
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
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace", keyCode: 8 }),
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
    const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
    if (!element.dispatchEvent(paste)) return;
    element.setRangeText("xyz", element.selectionStart, element.selectionEnd, "end");
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: "xyz" }));
  });
  await expectRead(page, terminal, "ed 95 9c e3 84 b1 78 79 7a");
});

test("Safari on a Mac: replacement edits without composition events reach the program as 한글", async ({ page }) => {
  const { terminal, field } = await openReader(page);
  await safariReplace(field, ["ㅎ", "하", "한"]);
  await safariReplace(field, ["ㄱ", "그", "글"]);
  await page.keyboard.type(" ");
  await expectRead(page, terminal, "ed 95 9c ea b8 80 20");
});
