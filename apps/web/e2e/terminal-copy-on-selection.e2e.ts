import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { disableCopyTrim, enableCopyOnSelection, openTerminalSettings } from "./terminal-settings.ts";

endOwnTerminals();
test.use({ serviceWorkers: "block" });

const BEFORE = "clipboard-before-selection";
const SELECTED = "copy-42-selected ";
const ROW = `${SELECTED}end`;
/** The selection as Copy leaves it with clipboard-trim-trailing-spaces on (the default): no space after the last glyph. */
const TRIMMED = "copy-42-selected";
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test.beforeEach(async ({ page }) => {
  // As in the clipboard-refusal specs, replace only the browser clipboard API. Each page owns its clipboard.
  await page.addInitScript((initial) => {
    let text = initial;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => text,
        writeText: async (next: string) => {
          text = next;
        },
      },
    });
  }, BEFORE);
});

async function terminalWithText(page: Page): Promise<Locator> {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("echo copy-$((6*7))-selected end");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(new RegExp(`${ROW}[\\s\\S]*\\$`), { timeout: 15_000 });
  return terminal;
}

async function textBounds(terminal: Locator) {
  return terminal.evaluate(
    (root, { row, selected }) => {
      const line = [...root.querySelectorAll(".term-row")].find((candidate) => candidate.textContent?.includes(row));
      if (line === undefined) throw new Error("the output line is not in the live terminal grid");
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(selected) ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + selected.length);
        const box = range.getBoundingClientRect();
        return { left: box.left + 1, right: box.right - 1, y: box.top + box.height / 2 };
      }
      throw new Error("the output line has no selectable text");
    },
    { row: ROW, selected: SELECTED },
  );
}

async function startSelection(page: Page, terminal: Locator): Promise<void> {
  const box = await textBounds(terminal);
  await page.mouse.move(box.left, box.y);
  await page.mouse.down();
  await page.mouse.move(box.right, box.y, { steps: 8 });
  await expect.poll(() => page.evaluate(() => getSelection()?.toString() ?? "")).toBe(SELECTED);
}

test("Terminal settings shows Copy on selection's plain label and its Ghostty key", async ({ page }) => {
  await page.goto("/");
  await openTerminalSettings(page);
  const row = page.locator("[data-setting-row]").filter({ hasText: "Copy on selection" });
  await expect(row).toContainText("Copy on selection");
  await expect(row).toContainText("copy-on-select");
});

test("Copy on selection is off by default: a drag leaves the seeded clipboard untouched", async ({ page }) => {
  const terminal = await terminalWithText(page);
  await startSelection(page, terminal);
  expect(await clipboard(page)).toBe(BEFORE);
  await page.mouse.up();
  expect(await clipboard(page)).toBe(BEFORE);
});

test("Copy on selection persists in Terminal settings and copies the mouseup selection trimmed as Copy does", async ({
  page,
}) => {
  await terminalWithText(page);
  await enableCopyOnSelection(page);
  await page.getByRole("link", { name: "Settings" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Copy on selection", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Close settings" }).first().click();
  const terminal = page.locator("[data-terminal]");
  await expect(terminal).toContainText(ROW, { timeout: 15_000 });
  await startSelection(page, terminal);
  expect(await clipboard(page)).toBe(BEFORE);
  await page.mouse.up();
  await expect.poll(() => clipboard(page)).toBe(TRIMMED);
});

test("with trim off, Copy on selection keeps the selection's trailing spaces", async ({ page }) => {
  const terminal = await terminalWithText(page);
  await enableCopyOnSelection(page);
  await disableCopyTrim(page);
  await startSelection(page, terminal);
  expect(await clipboard(page)).toBe(BEFORE);
  await page.mouse.up();
  await expect.poll(() => clipboard(page)).toBe(SELECTED);
});

test("with Copy on selection on, a plain click leaves the seeded clipboard untouched", async ({ page }) => {
  const terminal = await terminalWithText(page);
  await enableCopyOnSelection(page);
  const box = await textBounds(terminal);
  await page.mouse.click(box.left, box.y);
  expect(await clipboard(page)).toBe(BEFORE);
});

test("with Copy on selection on, clearing the selection before mouseup writes nothing", async ({ page }) => {
  const terminal = await terminalWithText(page);
  await enableCopyOnSelection(page);
  await startSelection(page, terminal);
  expect(await clipboard(page)).toBe(BEFORE);
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await page.mouse.up();
  expect(await clipboard(page)).toBe(BEFORE);
});
