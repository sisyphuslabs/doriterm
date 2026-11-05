// Closing a pane or tab ends its program, as herdr-app and Ghostty do; it asks first only while a program other than
// the shell runs, as confirm-close-surface says (#409).
import type { Page } from "@playwright/test";
import { runSleep, setConfirmClose } from "./close-confirm.ts";
import { expect, openNewTerminal, terminalCount, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

/** The pane and tab close keys for the browser's native platform. */
const CLOSE_PANE = process.platform === "darwin" ? "Meta+KeyW" : "Control+Shift+X";
const CLOSE_TAB = process.platform === "darwin" ? "Meta+Alt+KeyW" : "Control+Shift+KeyW";

const live = (page: Page, address: string) => page.locator(`[data-terminal="${address}"]`);
const question = (page: Page) => page.getByRole("dialog", { name: /^Close .+\?$/ });
const ended = (page: Page, count: number) =>
  expect(page.getByRole("contentinfo")).toContainText(`${count} terminal`, { timeout: 15_000 });

test("closing an idle shell ends it with no question", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  const { before } = await terminalCount(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.press(CLOSE_PANE);
  await ended(page, before - 1);
  await expect(live(page, address)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("closing a tab of two idle shells ends both with no question", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  const first = await openNewTerminal(page);
  const tabs = await page.getByRole("tab").count();
  const { before } = await terminalCount(page);
  await first.getByRole("textbox").focus();
  await page.getByRole("button", { name: "Split right" }).click();
  await ended(page, before + 1);
  await expect(page.getByRole("tab")).toHaveCount(tabs);
  await page.keyboard.press(CLOSE_TAB);
  await ended(page, before - 1);
  await expect(page.getByRole("tab")).toHaveCount(tabs - 1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("closing a shell with a program running asks once, and Close ends it", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  await runSleep(page, terminal);
  const { before } = await terminalCount(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.press(CLOSE_PANE);
  const ask = question(page);
  await expect(ask.getByRole("button")).toHaveText(["Cancel", "Close"]);
  await ask.getByRole("button", { name: "Close" }).click();
  await ended(page, before - 1);
  await expect(live(page, address)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("confirm-close-surface = false never asks, even with a program running", async ({ page }) => {
  await setConfirmClose(page, "false");
  await openNewTerminal(page);
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  await runSleep(page, terminal);
  const { before } = await terminalCount(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.press(CLOSE_PANE);
  await ended(page, before - 1);
  await expect(live(page, address)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
