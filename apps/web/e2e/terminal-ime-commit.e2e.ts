import type { CDPSession, Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";

// A syllable an input method commits reaches the program as it is committed, as Ghostty sends committed text: nothing
// waits for a key after it (#1104).
test.use({ serviceWorkers: "block" });

const HAN = "\u{D55C}";

/**
 * Puts the shell's terminal in raw mode under od, which prints each three bytes it reads in hex as they arrive: no
 * Enter, so only bytes the terminal sent on their own show.
 */
async function openRawReader(page: Page, terminal: Locator): Promise<CDPSession> {
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("stty -icanon -echo min 1 time 0; echo RE''ADY; od -An -tx1 -w3 -v\r");
  await expect(terminal.locator(".term-row").filter({ hasText: /^READY/ })).toHaveCount(1);
  return page.context().newCDPSession(page);
}

async function expectRead(terminal: Locator, hex = "ed 95 9c"): Promise<void> {
  await expect(terminal.locator(".term-row").filter({ hasText: new RegExp(`^\\s*${hex}\\s*$`) })).toHaveCount(1);
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

test("a lone jamo committed with no composition and no Korean key reaches the program at once (#1244)", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const cdp = await openRawReader(page, terminal);
  // An input method that inserts a jamo as plain text: no composition, and no key naming it before the edit.
  await cdp.send("Input.insertText", { text: "\u{314B}" });
  await expectRead(terminal, "e3 85 8b");
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
  await expectRead(terminal);
});
