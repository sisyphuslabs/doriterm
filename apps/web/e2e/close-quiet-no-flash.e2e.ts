// #518: closing an idle pane needs no question under confirm-close-surface, so none may show, not even while its End
// is still settling after the terminal has already left the list.
import { stateOn } from "./ended-terminal.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";
import { routeHcSocket } from "./hc-socket.ts";

test.use({ serviceWorkers: "block" });

test("an idle pane closes with no question, while its End settles and after", async ({ page }) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  await pressShortcut(page, "pane.split:right");
  const panes = page.locator("[role=tabpanel]:not([hidden]) section[data-split]");
  await expect(panes).toHaveCount(2, { timeout: 15_000 });
  const closing = page.locator('[data-focused="true"] [data-terminal]');
  await expect(closing).toContainText("$", { timeout: 15_000 });
  const address = (await closing.getAttribute("data-terminal")) ?? "";
  await closing.getByRole("textbox").focus();

  // End kills the program, then removes the terminal: its own removal is held, so End is still running once the program
  // is over and the terminal has left the live list (the host's end sweeper may remove it first).
  const releaseRemoval = link.hold("terminal.rm");
  await pressShortcut(page, "pane.close");
  await expect.poll(() => stateOn("host", address), { timeout: 15_000 }).not.toBe("live");
  await expect(panes).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);

  releaseRemoval();
  await expect.poll(() => stateOn("host", address), { timeout: 15_000 }).toBe("gone");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
