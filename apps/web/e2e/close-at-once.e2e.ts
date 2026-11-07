// Closing takes effect on screen as it is chosen; the End behind it takes its round trips without holding the pane or
// the tab (#1271). The kill is held at the page's socket, so the order is decided by the code, not by a clock.
import type { Page } from "@playwright/test";
import { expect, openNewTerminal, terminalCount, test } from "./fixtures.ts";
import { runSleep } from "./close-confirm.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { hcOn } from "./machine-switch.ts";

test.use({ serviceWorkers: "block" });

const kept: string[] = [];
test.afterEach(() => {
  for (const address of kept.splice(0)) hcOn("host", ["kill", address]);
});

const CLOSE_PANE = process.platform === "darwin" ? "Meta+KeyW" : "Control+Shift+X";
const CLOSE_TAB = process.platform === "darwin" ? "Meta+Alt+KeyW" : "Control+Shift+KeyW";

const pane = (page: Page, address: string) => page.locator(`[data-terminal="${address}"]`);
const running = (page: Page, count: number) =>
  expect(page.getByRole("contentinfo")).toContainText(`${count} terminal`, { timeout: 15_000 });

test("closing a pane takes it away while its kill is still on the way", async ({ page }) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  const { before } = await terminalCount(page);
  const release = link.hold("terminal.kill");
  await terminal.getByRole("textbox").focus();
  await page.keyboard.press(CLOSE_PANE);
  await expect(pane(page, address)).toHaveCount(0);
  await running(page, before);
  release();
  await running(page, before - 1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a close the person confirmed leaves with its question, while its kill is still on the way", async ({ page }) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  await runSleep(page, terminal);
  const { before } = await terminalCount(page);
  const release = link.hold("terminal.kill");
  await terminal.getByRole("textbox").focus();
  await page.keyboard.press(CLOSE_PANE);
  await page
    .getByRole("dialog", { name: /^Close .+\?$/ })
    .getByRole("button", { name: "Close" })
    .click();
  await expect(pane(page, address)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await running(page, before);
  release();
  await running(page, before - 1);
});

test("closing a tab of two panes takes the tab away while its kills are still on the way, and a failed End says so", async ({
  page,
}) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  const first = await openNewTerminal(page);
  const tabs = await page.getByRole("tab").count();
  const { before } = await terminalCount(page);
  await first.getByRole("textbox").focus();
  await page.getByRole("button", { name: "Split right" }).click();
  await running(page, before + 1);
  const panes = page.locator('[role="tabpanel"]:not([hidden]) [data-terminal]');
  await expect(panes).toHaveCount(2);
  await expect(panes.last()).toContainText("$", { timeout: 15_000 });
  kept.push(...(await panes.evaluateAll((els) => els.map((el) => el.getAttribute("data-terminal") ?? ""))));
  const release = link.hold("terminal.kill");
  await page.keyboard.press(CLOSE_TAB);
  await expect(page.getByRole("tab")).toHaveCount(tabs - 1);
  await running(page, before + 1);
  release(true);
  await expect(page.getByText("A session did not end")).toBeVisible({ timeout: 15_000 });
  await running(page, before + 1);
});
