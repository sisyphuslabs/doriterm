import { expect, openNewTerminal, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

// A program's Alt+Up (ESC [ 1 ; 3 A) is how agent question UIs take "previous answer", and how an editor takes a word
// move. Doriterm may bind a chord to its own action, but a chord with no pane target must not be swallowed by the shell.
test("Alt+Up reaches the program on a lone pane", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const textbox = terminal.getByRole("textbox");
  await textbox.focus();
  // cat -v prints what it receives, so the escape shows up as text the assertion can read.
  await page.keyboard.type("cat -v");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("cat -v", { timeout: 20_000 });

  await page.keyboard.press("Alt+ArrowUp");
  await expect(terminal, "the program receives Alt+Up's sequence").toContainText("[1;3A", { timeout: 20_000 });
});

test("Alt+Up reaches the program at the top edge of a split, and the pane does not move", async ({ page }) => {
  await page.goto("/");
  const first = await openNewTerminal(page);
  await page.keyboard.press("Meta+d");
  const panes = page.locator("[role=tabpanel]:not([hidden]) section[data-split]");
  await expect(panes, "the tab holds a split").toHaveCount(2, { timeout: 20_000 });
  const textbox = first.getByRole("textbox");
  await textbox.focus();
  await page.keyboard.type("cat -v");
  await page.keyboard.press("Enter");
  await expect(first).toContainText("cat -v", { timeout: 20_000 });

  // The focused pane is at the left edge of a row: "up" has no pane to go to, which is the case the report is about.
  await page.keyboard.press("Alt+ArrowUp");
  await expect(first, "the program still receives Alt+Up at the edge").toContainText("[1;3A", { timeout: 20_000 });
  await expect(panes, "and no pane was opened or closed by it").toHaveCount(2);
});
