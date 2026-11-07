// #522: copied terminal text leaves out each line's trailing spaces and the blank rows after the last text, as Ghostty
// does by default (clipboard-trim-trailing-spaces), whichever way the text is copied.
import type { Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { pressShortcut } from "./platform-keys.ts";

endOwnTerminals();

test.use({ serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

/** Lines that end in a space or tab, and whether the text ends in a newline. */
const untrimmed = (text: string) => ({
  padded: text.split("\n").filter((line) => /[ \t]$/.test(line)),
  trailingNewline: text.endsWith("\n"),
});

async function terminalWithOutput(page: Page) {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("echo trim-$((6*7))-end");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(/trim-42-end[\s\S]*\$/, { timeout: 15_000 });
  await page.evaluate(() => navigator.clipboard.writeText("before"));
  return terminal;
}

test("Select all then Copy puts the screen's text without line-end spaces or the empty rows after it", async ({
  page,
}) => {
  await terminalWithOutput(page);
  await pressShortcut(page, "terminal.select_all");
  await pressShortcut(page, "terminal.copy");
  await expect.poll(() => clipboard(page)).toContain("trim-42-end");
  expect(untrimmed(await clipboard(page))).toEqual({ padded: [], trailingNewline: false });
});

test("a drag past the end of a line copies the line without the spaces after it", async ({ page }) => {
  const terminal = await terminalWithOutput(page);
  const row = await terminal.evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = node.textContent?.lastIndexOf("trim-42-end") ?? -1;
      if (at < 0 || node.textContent?.includes("echo") === true) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + "trim-42-end".length);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, y: rect.top + rect.height / 2, end: root.getBoundingClientRect().right - 8 };
    }
    return null;
  });
  if (row === null) throw new Error("the output line is not in the terminal");
  await page.mouse.move(row.left + 1, row.y);
  await page.mouse.down();
  await page.mouse.move(row.end, row.y, { steps: 8 });
  await page.mouse.up();
  await pressShortcut(page, "terminal.copy");
  await expect.poll(() => clipboard(page)).toContain("trim-42-end");
  expect(await clipboard(page)).toBe("trim-42-end");
});
