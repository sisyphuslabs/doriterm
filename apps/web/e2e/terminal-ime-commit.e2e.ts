import type { CDPSession, Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";

// A syllable an input method commits reaches the program as it is committed, as Ghostty sends committed text: nothing
// waits for a key after it (#1104).
test.use({ serviceWorkers: "block" });

const HAN = "\u{D55C}";
const READER = "while :; do dd bs=1 count=3 2>/dev/null | od -An -tx1; done";

/**
 * Puts the shell's terminal in raw mode under a reader that prints each three bytes it reads in hex, one row per three:
 * no Enter, so only bytes the terminal sent on their own show, and a syllable sent twice prints a second row. dd reads
 * one byte at a time and ends at the third, so od prints at that end: the uutils od of ubuntu-26.04 keeps what it
 * reads until more comes, where GNU od printed each line as it arrived (#1952). The loop reads the next three bytes.
 */
async function openRawReader(page: Page, terminal: Locator): Promise<CDPSession> {
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`stty -icanon -echo min 1 time 0; echo RE''ADY; ${READER}\r`);
  await expect(terminal.locator(".term-row").filter({ hasText: /^READY/ })).toHaveCount(1);
  return page.context().newCDPSession(page);
}

/**
 * The syllable's row (or the given bytes' row) shows before anything else is typed, so a character held until the next
 * key fails here. Then three plain bytes go after it: once their row shows, every byte sent before them has been read,
 * so a second copy would already be on screen and the count of its rows must still be one.
 */
async function expectRead(terminal: Locator, cdp: CDPSession, hex = "ed 95 9c"): Promise<void> {
  const rows = terminal.locator(".term-row").filter({ hasText: new RegExp(`^\\s*${hex}\\s*$`) });
  await expect(rows).toHaveCount(1);
  await cdp.send("Input.insertText", { text: "zzz" });
  await expect(terminal.locator(".term-row").filter({ hasText: /^\s*7a 7a 7a\s*$/ })).toHaveCount(1);
  await expect(rows).toHaveCount(1);
}

test("a syllable committed with no composition events reaches the program at once (#1104)", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const cdp = await openRawReader(page, terminal);
  // An input method that commits its text as an insertion, with no composition before it.
  await cdp.send("Input.insertText", { text: HAN });
  await expectRead(terminal, cdp);
  await expect(terminal.getByRole("textbox")).toHaveValue("");
});

test("a syllable composed and then committed reaches the program at once (#1104)", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const cdp = await openRawReader(page, terminal);
  for (const text of ["\u{314E}", "\u{D558}", HAN]) {
    // oxlint-disable-next-line no-await-in-loop -- each jamo changes the preedit the one before it left
    await cdp.send("Input.imeSetComposition", { text, selectionStart: 1, selectionEnd: 1 });
  }
  await cdp.send("Input.insertText", { text: HAN });
  await expectRead(terminal, cdp);
});

test.fail("a syllable that reaches the program twice fails the check (#1952 review)", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const cdp = await openRawReader(page, terminal);
  await cdp.send("Input.insertText", { text: HAN + HAN });
  await expectRead(terminal, cdp);
});

test("a lone jamo committed with no composition and no Korean key reaches the program at once (#1244)", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const cdp = await openRawReader(page, terminal);
  // An input method that inserts a jamo as plain text: no composition, and no key naming it before the edit.
  await cdp.send("Input.insertText", { text: "\u{314B}" });
  await expectRead(terminal, cdp, "e3 85 8b");
});

test("each lone jamo an input method commits with no Korean key reaches the program, not only the first (#1244)", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const cdp = await openRawReader(page, terminal);
  const read = terminal.locator(".term-row").filter({ hasText: /^\s*e3 85 8b\s*$/ });
  // The first jamo is sent and stays in the field as sent text; the second is inserted after it, still with no key.
  await cdp.send("Input.insertText", { text: "\u{314B}" });
  await expect(read).toHaveCount(1);
  await cdp.send("Input.insertText", { text: "\u{314B}" });
  await expect(read).toHaveCount(2);
});

// Keys that type nothing: a modifier, a lock and the Hangul/English toggle a Korean keyboard has (Lang1 on Windows and
// macOS layouts). A lone jamo waiting for the key that would make it a syllable's first is still committed text when
// one of these goes down inside its wait (#1913).
const SILENT_KEYS = [
  { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 },
  { key: "CapsLock", code: "CapsLock", windowsVirtualKeyCode: 20, modifiers: 0 },
  { key: "HangulMode", code: "Lang1", windowsVirtualKeyCode: 21, modifiers: 0 },
  // The same toggle where the browser and input method name no key for it: only its code says what it is.
  { key: "Unidentified", code: "Lang1", windowsVirtualKeyCode: 21, modifiers: 0 },
] as const;

for (const silent of SILENT_KEYS)
  test(`${silent.key} (${silent.code}) pressed while a lone jamo waits for its key does not hold the jamo: it types nothing (#1913)`, async ({
    page,
  }) => {
    await page.goto("/");
    const terminal = await openNewTerminal(page);
    const cdp = await openRawReader(page, terminal);
    // Both commands are sent before either is awaited, so the key reaches the field in the same task batch as the
    // insertion, well inside the 100 ms the jamo waits.
    await Promise.all([
      cdp.send("Input.insertText", { text: "\u{314B}" }),
      cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...silent }),
    ]);
    await expectRead(terminal, cdp, "e3 85 8b");
  });

test("a Korean key whose keyup a blur took does not hold the next committed syllable (#1246)", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const cdp = await openRawReader(page, terminal);
  const field = terminal.getByRole("textbox");
  // A phone Korean keyboard's keydown names its jamo; focus leaves before the keyup arrives.
  await field.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "\u{314E}" }));
    if (element instanceof HTMLElement) element.blur();
  });
  await field.focus();
  await cdp.send("Input.insertText", { text: HAN });
  await expectRead(terminal, cdp);
});
