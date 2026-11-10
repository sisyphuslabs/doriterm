import type { Page } from "@playwright/test";
import { expect, openNewTerminal, terminalCount, test } from "./fixtures.ts";
import { pagePlatform, shortcut } from "./platform-keys.ts";

test.use({ serviceWorkers: "block" });

/** The address of the terminal whose input holds DOM focus. */
const focusedTerminal = (page: Page) =>
  page.evaluate(() =>
    document.activeElement instanceof HTMLTextAreaElement
      ? (document.activeElement.closest("[data-terminal]")?.getAttribute("data-terminal") ?? null)
      : null,
  );

test("the help chord lists the person's own keys, the same chord closes it, and focus goes back", async ({ page }) => {
  await page.goto("/settings");
  // herdr-app's app.help chord as the page's platform binds it: Cmd+/ on a Mac, Ctrl+? (Ctrl+Shift+/) elsewhere.
  const help = await shortcut(page, "app.help");
  // The chord recorded below as the person's own, as the dialog labels it: a Mac in its own modifier order (⌃⌥).
  const recorded = (await pagePlatform(page)) === "mac" ? /^⌃⌥K$/ : /^CtrlAltK$/;
  await page
    .getByRole("tab", { name: "Keybindings" })
    .or(page.getByRole("button", { name: "Keybindings" }))
    .first()
    .click();
  await page.getByRole("button", { name: "Record a shortcut for Command palette" }).click();
  await expect(page.getByRole("status")).toHaveText("Press keys…");
  await page.keyboard.press("Control+Alt+K");
  await expect(page.getByText("Changed")).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).first().click();

  const terminal = await openNewTerminal(page);
  const address = await terminal.getAttribute("data-terminal");
  await terminal.getByRole("textbox").focus();
  await expect.poll(() => focusedTerminal(page)).toBe(address);

  await page.keyboard.press(help);
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "App" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Terminal" })).toBeVisible();
  const palette = dialog.getByRole("listitem").filter({ hasText: "Command palette" });
  await expect(palette.locator("kbd").filter({ hasText: recorded })).toBeVisible();

  await page.keyboard.press(help);
  await expect(dialog).toBeHidden();
  await expect.poll(() => focusedTerminal(page)).toBe(address);
});

test("shortcuts opened from the palette return focus to the terminal when closed (#1230)", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = await terminal.getAttribute("data-terminal");
  await terminal.getByRole("textbox").focus();
  await page.keyboard.press(await shortcut(page, "app.palette"));
  const command = page.getByRole("combobox", { name: "Command" });
  await expect(command).toBeFocused();
  await command.fill("Keyboard shortcuts");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => focusedTerminal(page)).toBe(address);
});

test("shortcuts opened from the palette without a terminal return focus to its opener (#1230)", async ({ page }) => {
  await page.goto("/");
  await terminalCount(page);
  const opener = page.getByRole("button", { name: "Command palette" }).first();
  await opener.click();
  const command = page.getByRole("combobox", { name: "Command" });
  await expect(command).toBeFocused();
  await command.fill("Keyboard shortcuts");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("shortcuts stay closed after the workspace unmounts and mounts again (#1230)", async ({ page }) => {
  await page.goto("/");
  await terminalCount(page);
  await page.keyboard.press(await shortcut(page, "app.help"));
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  // A route outside the workspace removes its owner without reloading the page's modules.
  await page.evaluate(() => {
    history.pushState({}, "", "/pair");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.locator('aside[aria-label="Workspace"]')).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  await page.goBack();
  await expect(page.locator('aside[aria-label="Workspace"]')).toBeAttached();
  await expect(dialog).toHaveCount(0);
});
