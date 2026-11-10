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

async function expectRead(terminal: Locator): Promise<void> {
  await expect(terminal.locator(".term-row").filter({ hasText: /^\s*ed 95 9c\s*$/ })).toHaveCount(1);
}

test("a syllable committed with no composition events reaches the program at once (#1104)", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const cdp = await openRawReader(page, terminal);
  // An input method that commits its text as an insertion, with no composition before it.
  await cdp.send("Input.insertText", { text: HAN });
  await expectRead(terminal);
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
  await expectRead(terminal);
});
