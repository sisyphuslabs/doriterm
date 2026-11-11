import type { Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";

test.use({ serviceWorkers: "block" });

const focusIsIn = (page: Page, selector: string) =>
  page.evaluate((within) => document.activeElement?.closest(within) !== null, selector);

/** The address of the terminal whose input holds DOM focus. */
const focusedTerminal = (page: Page) =>
  page.evaluate(() =>
    document.activeElement instanceof HTMLTextAreaElement
      ? (document.activeElement.closest("[data-terminal]")?.getAttribute("data-terminal") ?? null)
      : null,
  );

test("the focus chord moves from the terminal to the sidebar and back, and Escape stays with the program", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = await terminal.getAttribute("data-terminal");
  await terminal.getByRole("textbox").focus();
  await page.keyboard.press("Escape");
  await expect.poll(() => focusedTerminal(page)).toBe(address);

  await pressShortcut(page, "layout.focus:sidebar");
  await expect.poll(() => focusIsIn(page, 'aside[aria-label="Workspace"]')).toBe(true);
  await pressShortcut(page, "layout.focus:sidebar");
  await expect.poll(() => focusedTerminal(page)).toBe(address);

  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await terminal.getByRole("textbox").focus();
  await pressShortcut(page, "layout.focus:sidebar");
  await expect(page.getByRole("complementary", { name: "Workspace" })).toBeVisible();
  await expect.poll(() => focusIsIn(page, 'aside[aria-label="Workspace"]')).toBe(true);
});

test("the focus chord does nothing while a dialog is open", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  const dialog = page.getByRole("dialog", { name: /^Rename / });
  await expect(dialog.getByRole("textbox", { name: "Name" })).toBeFocused();
  await pressShortcut(page, "layout.focus:sidebar");
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
});

test("the focus chord does nothing while the command palette is open, not even show a hidden sidebar", async ({
  page,
}) => {
  await page.goto("/");
  await openNewTerminal(page);
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(page.getByRole("complementary", { name: "Workspace" })).toBeHidden();
  await pressShortcut(page, "app.palette");
  const palette = page.getByRole("dialog", { name: /command/i });
  await expect(palette.getByRole("combobox")).toBeFocused();
  await pressShortcut(page, "layout.focus:sidebar");
  await expect(palette).toBeVisible();
  await expect.poll(() => palette.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(page.getByRole("complementary", { name: "Workspace" })).toBeHidden();
});
