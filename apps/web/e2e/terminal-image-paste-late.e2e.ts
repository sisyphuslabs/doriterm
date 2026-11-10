import type { Page } from "@playwright/test";
import { answerClipboard, asMac, copyImage, holdClipboard, makePng, readRawBytes } from "./clipboard-image.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { endOwnTerminals } from "./own-terminals.ts";

// #1938: Paste image's clipboard answering after its wait, while the person goes on typing. Its ^V or image path goes
// in then, and leaves a syllable still being composed alone; one notice says it is waiting, and it goes with the view.
endOwnTerminals();
test.use({ serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });

const HAN = "\u{D55C}";
const notice = (page: Page) => page.getByText("Waiting for the clipboard");

/** Starts composing a syllable in the focused field, as a Korean input method does, and leaves it unfinished. */
async function composing(page: Page): Promise<(text: string) => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);
  for (const text of ["\u{314E}", "\u{D558}"]) {
    // oxlint-disable-next-line no-await-in-loop -- each jamo changes the preedit the one before it left
    await cdp.send("Input.imeSetComposition", { text, selectionStart: 1, selectionEnd: 1 });
  }
  return async (text) => {
    await cdp.send("Input.insertText", { text });
  };
}

test("a ^V the clipboard gives mid-syllable reaches the program and leaves the syllable composing, on a Mac (#1938)", async ({
  page,
}) => {
  await asMac(page);
  await holdClipboard(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const field = terminal.getByRole("textbox");
  await field.focus();
  await page.evaluate(() => navigator.clipboard.writeText("only-text"));
  // Two raw reads: the first byte the program gets, then the next three, each printed as HEX:... once read.
  await page.keyboard.type(
    "stty raw -echo; printf 'RAW%s\\r\\n' -ON; for n in 1 3; do dd bs=1 count=$n 2>/dev/null | od -An -tx1 | sed 's/^ */HEX:/'; done; stty sane\r",
  );
  await expect(terminal).toContainText("RAW-ON", { timeout: 15_000 });
  await page.keyboard.press("Control+KeyV");
  await expect(notice(page)).toBeVisible({ timeout: 15_000 });
  const commit = await composing(page);
  await answerClipboard(page);
  // The ^V goes alone, and the syllable stays in the field, still being typed: nothing of it was sent.
  await expect(terminal).toContainText("HEX:16", { timeout: 15_000 });
  await expect(field).toHaveValue("\u{D558}");
  await expect(notice(page)).toBeHidden();
  // Finished, the syllable reaches the program as it was typed, after the ^V.
  await commit(HAN);
  await expect(terminal).toContainText("HEX:ed 95 9c", { timeout: 15_000 });
});

test("an image the clipboard gives mid-syllable is pasted by its path and leaves the syllable composing, on a Mac (#1938)", async ({
  page,
}) => {
  await asMac(page);
  await holdClipboard(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const field = terminal.getByRole("textbox");
  await field.focus();
  await copyImage(page, await makePng(page, 9, 150));
  await page.keyboard.type("IFS= read -r line; printf 'GOT:%s\\n' \"$line\"\r");
  await expect(terminal).toContainText("read -r line", { timeout: 15_000 });
  await page.keyboard.press("Control+KeyV");
  await expect(notice(page)).toBeVisible({ timeout: 15_000 });
  const commit = await composing(page);
  await answerClipboard(page);
  await expect(terminal).toContainText("doriface-paste-", { timeout: 30_000 });
  await expect(field).toHaveValue("\u{D558}");
  await commit(HAN);
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(new RegExp(`GOT:\\S*doriface-paste-\\d+\\.png ${HAN}`, "u"), {
    timeout: 30_000,
  });
});

test("a second Ctrl+V while the clipboard is still asking adds no second notice, and both get their ^V, on a Mac (#1938)", async ({
  page,
}) => {
  await asMac(page);
  await holdClipboard(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.evaluate(() => navigator.clipboard.writeText("only-text"));
  await page.keyboard.type(
    "stty raw -echo; printf 'RAW%s\\r\\n' -ON; for n in 1 2; do dd bs=1 count=$n 2>/dev/null | od -An -tx1 | sed 's/^ */HEX:/'; done; stty sane\r",
  );
  await expect(terminal).toContainText("RAW-ON", { timeout: 15_000 });
  await page.keyboard.press("Control+KeyV");
  await expect(notice(page)).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Control+KeyV");
  // The x waits behind the second press until its wait ends: once the program has it, that press is waiting too.
  await page.keyboard.press("x");
  await expect(terminal).toContainText("HEX:78", { timeout: 15_000 });
  await expect(notice(page)).toHaveCount(1);
  await answerClipboard(page);
  await expect(terminal).toContainText("HEX:16 16", { timeout: 15_000 });
  await expect(notice(page)).toHaveCount(0);
});

test("leaving the tab while the clipboard is asking closes the notice, and its late answer sends nothing there, on a Mac (#1938)", async ({
  page,
}) => {
  await asMac(page);
  await holdClipboard(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  const tabs = page.getByRole("tablist", { name: "Tabs" });
  const first = await tabs.locator('[data-tab-id]:has([role="tab"][aria-selected="true"])').getAttribute("data-tab-id");
  await page.evaluate(() => navigator.clipboard.writeText("only-text"));
  await readRawBytes(page, terminal, 1);
  await page.keyboard.press("Control+KeyV");
  await expect(notice(page)).toBeVisible({ timeout: 15_000 });
  await openNewTerminal(page);
  await expect(notice(page)).toBeHidden();
  await answerClipboard(page);
  // Back in the first tab, the key typed there is the first byte its program reads: no ^V went before it.
  await tabs.locator(`[data-tab-id="${first}"] [role="tab"]`).click();
  await terminal.getByRole("textbox").focus();
  await page.keyboard.press("q");
  await expect(terminal).toContainText(/HEX:\S+/u, { timeout: 15_000 });
  await expect(terminal).toContainText("HEX:71");
  await expect(notice(page)).toHaveCount(0);
});
