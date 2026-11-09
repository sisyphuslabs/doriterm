import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";
import { endOwnTerminals } from "./own-terminals.ts";

endOwnTerminals();

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

/** The address of the terminal whose input holds DOM focus, read from document.activeElement. */
const focusedAddress = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement
      ? (active.closest("[data-terminal]")?.getAttribute("data-terminal") ?? null)
      : null;
  });

/**
 * The selection a press left is painted from whole cells the terminal holds, and is not left as the document's
 * selection: a non-collapsed document selection over the rows stops IME composition (#592).
 */
async function expectHeldSelection(page: Page, terminal: Locator): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString() ?? "")).toBe("");
  await expect(terminal.locator(".term-selection-cells > div").first()).toBeVisible();
}

/** Where the first rendered `text` sits in the terminal, the point a drag across it starts from and ends at. */
async function textBox(terminal: Locator, text: string): Promise<{ left: number; right: number; y: number }> {
  const box = await terminal.evaluate((root, needle) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(needle) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
    }
    return null;
  }, text);
  if (box === null) throw new Error(`"${text}" is not in the terminal`);
  return box;
}

test("clicking New tab puts keyboard focus in the new terminal", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  const opened = await openNewTerminal(page);
  await expect.poll(() => focusedAddress(page)).toBe(await opened.getAttribute("data-terminal"));
});

test("opening a terminal from the sidebar puts keyboard focus in it", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  await openNewTerminal(page);
  // After a reload only the first live terminal has a tab, so another sidebar row opens a new one.
  await page.reload();
  const shown = page.locator('[data-focused="true"] [data-terminal]');
  await expect(shown).toContainText("$", { timeout: 15_000 });
  const before = await shown.getAttribute("data-terminal");
  const sidebar = page.getByRole("complementary", { name: "Workspace" });
  // New shells report no state, so they list under Idle; the one without aria-current has no tab yet.
  await sidebar.getByRole("region", { name: "Idle" }).locator("button:not([aria-current])").first().click();
  await expect(shown).not.toHaveAttribute("data-terminal", before ?? "");
  await expect(shown).toContainText("$", { timeout: 15_000 });
  await expect.poll(() => focusedAddress(page)).toBe(await shown.getAttribute("data-terminal"));
});

test("dismissing the palette gives keyboard focus back to the terminal", async ({ page }) => {
  await page.goto("/");
  const opened = await openNewTerminal(page);
  await opened.getByRole("textbox").focus();
  await page.getByRole("button", { name: "Command palette" }).first().click();
  await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
  await expect.poll(() => focusedAddress(page)).toBe(await opened.getAttribute("data-terminal"));

  // The backdrop is the other way to dismiss it with a pointer.
  await page.getByRole("button", { name: "Command palette" }).first().click();
  await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
  // The top-left corner is backdrop: the palette sits centred near the top.
  await page.mouse.click(5, 5);
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
  await expect.poll(() => focusedAddress(page)).toBe(await opened.getAttribute("data-terminal"));
});

test("dismissing the palette over the paste dialog leaves focus in that dialog, not the shell behind it", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const input = terminal.getByRole("textbox");
  await input.focus();
  await input.evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", "echo one\necho two\n");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const paste = page.getByRole("dialog", { name: /Paste 3 lines/ });
  await expect(paste).toBeVisible();
  // The dialog moves focus into itself just after it opens; the palette is opened from there.
  await expect.poll(() => paste.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  await pressShortcut(page, "app.palette");
  // The paste dialog marks everything outside it aria-hidden, the palette included.
  const palette = page.getByRole("combobox", { name: "Command", includeHidden: true });
  await expect(palette).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(paste).toBeVisible();
  await expect.poll(() => paste.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  await page.keyboard.type("qqleak");
  await expect(terminal).not.toContainText("qqleak");
});

test.describe("with clipboard access", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("selecting text with the mouse keeps keyboard focus in the terminal and copy still works", async ({ page }) => {
    await page.goto("/");
    const terminal = await openNewTerminal(page);
    const address = await terminal.getAttribute("data-terminal");
    await terminal.getByRole("textbox").focus();
    await page.keyboard.type("echo copysrc-$((6*7))-end");
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText("copysrc-42-end", { timeout: 15_000 });

    // The drag runs across the output line's own glyphs, as a user would select it.
    const box = await terminal.evaluate((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.textContent?.indexOf("copysrc-42-end") ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + "copysrc-42-end".length);
        const rect = range.getBoundingClientRect();
        return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
      }
      return null;
    });
    if (box === null) throw new Error("the output line is not in the terminal");
    await page.mouse.move(box.left + 1, box.y);
    await page.mouse.down();
    await page.mouse.move(box.right - 1, box.y, { steps: 8 });
    await page.mouse.up();
    await expectHeldSelection(page, terminal);

    await pressShortcut(page, "terminal.copy");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("copysrc-42");
    await expect.poll(() => focusedAddress(page)).toBe(address);
    await page.keyboard.type("echo after-$((2+3))");
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText("after-5", { timeout: 15_000 });
  });

  for (const [gesture, clicks] of [
    ["double-click on a word", 2],
    ["triple-click on a line", 3],
  ] as const) {
    test(`a ${gesture} keeps keyboard focus in the terminal and copy still works (#516)`, async ({ page }) => {
      await page.goto("/");
      const terminal = await openNewTerminal(page);
      const address = await terminal.getAttribute("data-terminal");
      await terminal.getByRole("textbox").focus();
      await page.keyboard.type("echo clicksrc-$((6*7))");
      await page.keyboard.press("Enter");
      await expect(terminal).toContainText("clicksrc-42", { timeout: 15_000 });

      const at = await terminal.evaluate((root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const index = node.textContent?.indexOf("clicksrc-42") ?? -1;
          // The output line, not the echoed command: it starts the row.
          if (index !== 0) continue;
          const range = document.createRange();
          range.setStart(node, 0);
          range.setEnd(node, "clicksrc".length);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
        return null;
      });
      if (at === null) throw new Error("the output line is not in the terminal");
      await page.mouse.click(at.x, at.y, { clickCount: clicks });
      await expectHeldSelection(page, terminal);

      await expect.poll(() => focusedAddress(page)).toBe(address);
      await pressShortcut(page, "terminal.copy");
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("clicksrc");
      await page.keyboard.type("echo after-$((2+3))");
      await page.keyboard.press("Enter");
      await expect(terminal).toContainText("after-5", { timeout: 15_000 });
    });
  }
});

test("typing Hangul right after a drag-select composes, rather than each jamo arriving on its own (#592)", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("echo imesrc-$((6*7))-end");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("imesrc-42-end", { timeout: 15_000 });
  const box = await textBox(terminal, "imesrc-42-end");
  await page.mouse.move(box.left + 1, box.y);
  await page.mouse.down();
  await page.mouse.move(box.right - 1, box.y, { steps: 8 });
  await page.mouse.up();

  // The input must hold focus WITH a caret: focusing it while a range is still selected leaves rangeCount at 0 once
  // the range is emptied, and macOS's Korean input method then commits each jamo on its own (#953).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const selection = document.getSelection();
        return `${document.activeElement?.tagName} ${selection?.rangeCount} ${selection?.isCollapsed}`;
      }),
    )
    .toBe("TEXTAREA 1 true");

  // The browser's own IME path for the first Hangul key: a preedit into the focused input. A non-collapsed document
  // selection over the rows makes Blink drop it and forward the keystroke as its own jamo instead.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "\uD55C", selectionStart: 1, selectionEnd: 1 });
  await expect(terminal.getByRole("textbox")).toHaveValue("\uD55C");
  await expectHeldSelection(page, terminal);
});

test("clicking Split right puts keyboard focus in the new pane beside the first, where typing lands", async ({
  page,
}) => {
  await page.goto("/");
  const first = await openNewTerminal(page);
  const firstAddress = await first.getAttribute("data-terminal");

  await page.getByRole("button", { name: "Split right" }).click();
  await expect(page.locator("[data-terminal]:visible")).toHaveCount(2, { timeout: 15_000 });
  await expect.poll(() => focusedAddress(page), { timeout: 15_000 }).not.toBe(firstAddress);
  const address = await focusedAddress(page);
  if (address === null) throw new Error("keyboard focus is in no terminal after the split");
  const created = page.locator(`[data-terminal="${address}"]`);
  await expect(created).toContainText("$", { timeout: 15_000 });
  // Enter typed here must reach the new shell, not press Split right again.
  await page.keyboard.type("echo split-$((3+4))");
  await page.keyboard.press("Enter");
  await expect(created).toContainText("split-7", { timeout: 15_000 });
  await expect(first).not.toContainText("split-7");
});

test("closing the palette with its shortcut or by running an action gives focus back to the terminal", async ({
  page,
}) => {
  await page.goto("/");
  const opened = await openNewTerminal(page);
  const address = await opened.getAttribute("data-terminal");
  const palette = page.getByRole("combobox", { name: "Command" });

  await opened.getByRole("textbox").focus();
  await pressShortcut(page, "app.palette");
  await expect(palette).toBeFocused();
  await pressShortcut(page, "app.palette");
  await expect(palette).toBeHidden();
  await expect.poll(() => focusedAddress(page)).toBe(address);

  await pressShortcut(page, "app.palette");
  await page.getByRole("option", { name: /^Larger terminal text/ }).click();
  await expect(palette).toBeHidden();
  await expect.poll(() => focusedAddress(page)).toBe(address);
});
