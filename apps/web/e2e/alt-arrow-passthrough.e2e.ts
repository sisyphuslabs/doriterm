import type { Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

/**
 * The bug is on Windows and Linux, where Alt+arrows were bound to Doriterm's own actions, so the platform is pinned the
 * way split-resize.e2e.ts pins it: a macOS run would otherwise exercise the mac keymap, where Alt+Up was never an app
 * action, and pass without touching the regression.
 */
async function setPlatform(page: Page, platform: "mac" | "other"): Promise<void> {
  await page.addInitScript(
    (value) => Object.defineProperty(Navigator.prototype, "platform", { get: () => value }),
    platform === "mac" ? "MacIntel" : "Linux x86_64",
  );
}

// A program's Alt+Up (ESC [ 1 ; 3 A) is how agent question UIs take "previous answer", and how an editor takes a word
// move. Doriterm may bind a chord to its own action, but Alt+arrows belong to the program (#1302).
test("Alt+Up reaches the program on a lone pane", async ({ page }) => {
  await setPlatform(page, "other");
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  // cat -v prints what it receives, so the escape shows up as text the assertion can read.
  await page.keyboard.type("cat -v");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("cat -v", { timeout: 20_000 });

  await page.keyboard.press("Alt+ArrowUp");
  await expect(terminal, "the program receives Alt+Up's sequence").toContainText("[1;3A", { timeout: 20_000 });
});

test("Alt+Up reaches the program at the top edge of a split, and the pane does not move", async ({ page }) => {
  await setPlatform(page, "other");
  await page.goto("/");
  const first = await openNewTerminal(page);
  // Ctrl+Shift+O splits on this platform (defaults.ts, the Linux and Windows set).
  await page.keyboard.press("Control+Shift+O");
  const panes = page.locator("[role=tabpanel]:not([hidden]) section[data-split]");
  await expect(panes, "the tab holds a split").toHaveCount(2, { timeout: 20_000 });
  await first.getByRole("textbox").focus();
  await page.keyboard.type("cat -v");
  await page.keyboard.press("Enter");
  await expect(first).toContainText("cat -v", { timeout: 20_000 });

  // The focused pane is at the left edge of a row: "up" has no pane to go to, which is the case the report is about.
  await page.keyboard.press("Alt+ArrowUp");
  await expect(first, "the program still receives Alt+Up at the edge").toContainText("[1;3A", { timeout: 20_000 });
  await expect(panes, "and no pane was opened or closed by it").toHaveCount(2);
});
