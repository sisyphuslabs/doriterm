import type { Page } from "@playwright/test";
import { runSleep } from "./close-confirm.ts";
import { expect, openNewTerminal, terminalCount, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

const liveCount = async (page: Page): Promise<number> => (await terminalCount(page)).before;

const pane = (page: Page) => page.locator('[data-focused="true"]');

/** The close button of the selected tab, which sits beside it in the tab's pill. */
const closeSelected = (page: Page) =>
  page
    .getByRole("tab", { selected: true })
    .locator("xpath=..")
    .getByRole("button", { name: /^Close / });

/** The session actions sit in the tab strip beside Split and act on the focused terminal. */
async function sessionMenu(page: Page, item: string): Promise<void> {
  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test("a pane has no title bar: the tab names the terminal and the status bar names its space", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  await expect(pane(page).getByRole("heading")).toHaveCount(0);
  await expect(pane(page).getByRole("button", { name: "Session actions" })).toHaveCount(0);
  // A new shell's title moves from its argv (/bin/sh) to the program's name (sh): read the pane and the button together.
  const sessionActions = page.getByRole("button", { name: /^Session actions for / });
  await expect
    .poll(async () => {
      const title = (await pane(page).getAttribute("aria-label"))?.replace(/ terminal$/, "");
      return (await sessionActions.getAttribute("aria-label")) === `Session actions for ${title}`;
    })
    .toBe(true);
  // No tooltip on a tab, as herdr-app's strip (#466 ruling A); tab-shortcuts.e2e.ts presses each tab's chord.
  await expect(page.getByRole("tab", { selected: true })).not.toHaveAttribute("title");
  // The status bar names the focused terminal's space: the same one the sidebar's Spaces list marks current.
  const currentSpace = page
    .getByRole("region", { name: "Spaces" })
    .locator('[aria-current="true"] [data-floor="name"]');
  await expect(currentSpace).toHaveText(/\S/);
  await expect(page.getByRole("contentinfo").locator("[data-status-space] [title]")).toHaveText(
    await currentSpace.innerText(),
  );
});

test("renaming a session from the tab strip renames its pane, and the tab keeps its number, as herdr-app's", async ({
  page,
}) => {
  await page.goto("/");
  await openNewTerminal(page);
  await sessionMenu(page, "Rename…");
  const dialog = page.getByRole("dialog", { name: /^Rename / });
  await dialog.getByRole("textbox", { name: "Name" }).fill("deploy-check");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Session actions for deploy-check" })).toBeVisible();
  await expect(page.getByRole("tab", { selected: true })).toHaveText(/^\d+$/);
  await expect(pane(page)).toHaveAttribute("aria-label", "deploy-check terminal");
});

test("ending a session from the tab strip stops the program", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  const before = await liveCount(page);
  await sessionMenu(page, "End session…");
  await page.getByRole("dialog", { name: /^End / }).getByRole("button", { name: "End session" }).click();
  await expect(page.getByRole("contentinfo")).toContainText(`${before - 1} terminal`, { timeout: 15_000 });
});

test("closing a tab whose shell runs a program asks first: Cancel leaves it running, Close ends it", async ({
  page,
}) => {
  await page.goto("/");
  await runSleep(page, await openNewTerminal(page));
  const before = await liveCount(page);
  const ask = page.getByRole("dialog", { name: /^Close .+\?$/ });
  await closeSelected(page).click();
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toBeHidden();
  await expect(page.getByRole("button", { name: /^Session actions for sleep/ })).toBeVisible();
  await expect(page.getByRole("contentinfo")).toContainText(`${before} terminal`);

  await closeSelected(page).click();
  await ask.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("contentinfo")).toContainText(`${before - 1} terminal`, { timeout: 15_000 });
});

test("Close in the close prompt is styled destructive like End session, and Enter answers nothing", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await sessionMenu(page, "End session…");
  const confirm = page.getByRole("dialog", { name: /^End / });
  const destructive = await confirm
    .getByRole("button", { name: "End session" })
    .evaluate((button) => getComputedStyle(button).backgroundColor);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await runSleep(page, terminal);
  const before = await liveCount(page);
  await closeSelected(page).click();
  const ask = page.getByRole("dialog", { name: /^Close .+\?$/ });
  const end = ask.getByRole("button", { name: "Close" });
  expect(await end.evaluate((button) => getComputedStyle(button).backgroundColor)).toBe(destructive);
  // No answer is the default (#1495): Enter leaves the question up and the terminal running; Escape dismisses it.
  await page.keyboard.press("Enter");
  await expect(ask).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(ask).toBeHidden();
  await expect(page.getByRole("contentinfo")).toContainText(`${before} terminal`);
  await expect(page.getByRole("tab", { selected: true })).toBeVisible();
});

test("a session menu finishing after Cancel leaves the keyboard in the terminal (#2521)", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  // Keep the menu's exit pending until after the question is dismissed and the terminal takes focus.
  // Finishing the paused animation below chooses the order without waiting for a duration.
  await page.addStyleTag({
    content:
      "@keyframes held-session-exit { from { opacity: 1; } to { opacity: 0; } } [role='menu'][data-ending-style] { animation: held-session-exit 1s linear paused !important; }",
  });
  await sessionMenu(page, "End session…");
  const confirm = page.getByRole("dialog", { name: /^End / });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  const input = terminal.getByRole("textbox");
  await input.focus();
  await expect(input).toBeFocused();
  const closingMenu = page.getByRole("menu", { includeHidden: true });
  await expect(closingMenu).toHaveCount(1);
  await closingMenu.evaluate((menu) => {
    const exit = menu.getAnimations().find((animation) => animation instanceof CSSAnimation);
    if (exit === undefined) throw new Error("The session menu has no held exit animation");
    exit.finish();
  });
  await expect(closingMenu).toHaveCount(0);
  await expect(input).toBeFocused();
  await runSleep(page, terminal);
});
