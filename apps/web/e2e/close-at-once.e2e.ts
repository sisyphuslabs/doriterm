// Closing takes effect on screen as it is chosen; the End behind it takes its round trips without holding the pane or
// the tab (#1271). The kill is held at the page's socket, so the order is decided by the code, not by a clock.
import type { Page } from "@playwright/test";
import { expect, openNewTerminal, terminalCount, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";
import { runSleep } from "./close-confirm.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { hcOn } from "./machine-switch.ts";

test.use({ serviceWorkers: "block" });

const kept: string[] = [];
test.afterEach(() => {
  for (const address of kept.splice(0)) hcOn("host", ["kill", address]);
});

const pane = (page: Page, address: string) => page.locator(`[data-terminal="${address}"]`);
const running = (page: Page, count: number) =>
  expect(page.getByRole("contentinfo")).toContainText(`${count} terminal`, { timeout: 15_000 });

/** Whether the core still holds this terminal, finished ones included. */
function onCore(address: string): boolean {
  const listed: unknown = JSON.parse(hcOn("host", ["ls", "--all", "--json"]));
  const terminals = typeof listed === "object" && listed !== null ? Reflect.get(listed, "terminals") : undefined;
  if (!Array.isArray(terminals)) throw new Error("hc ls printed no terminal list");
  return terminals.some((terminal) => JSON.stringify(terminal).includes(`"${address}"`));
}

/** One tab of two panes with both programs running, in a space that has another tab to keep. */
async function twoPaneTab(page: Page): Promise<{ readonly panes: readonly string[]; readonly tabs: number }> {
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
  return { panes: await panes.evaluateAll((els) => els.map((el) => el.getAttribute("data-terminal") ?? "")), tabs };
}

test("closing a pane takes it away while its kill is still on the way", async ({ page }) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  const { before } = await terminalCount(page);
  const release = link.hold("terminal.kill");
  await terminal.getByRole("textbox").focus();
  await pressShortcut(page, "pane.close");
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
  await pressShortcut(page, "pane.close");
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
  await pressShortcut(page, "tab.close");
  await expect(page.getByRole("tab")).toHaveCount(tabs - 1);
  await running(page, before + 1);
  release(true);
  await expect(page.getByText("2 sessions did not end")).toBeVisible({ timeout: 15_000 });
  await running(page, before + 1);
});

test("a tab close whose Ends never left the page is finished by the next page", async ({ page }) => {
  const link = await routeHcSocket(page);
  const { panes, tabs } = await twoPaneTab(page);
  // The Ends' marks and kills stay on the page's side of the wire, as when a page closes mid-End.
  link.hold("terminal.label", "terminal.kill");
  await pressShortcut(page, "tab.close");
  await expect(page.getByRole("tab")).toHaveCount(tabs - 1);
  const recorded = () =>
    page.evaluate(
      () =>
        Object.keys(localStorage)
          .filter((key) => key.startsWith("doriface.pending-ends.v1."))
          .flatMap((key) => {
            const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
            return Array.isArray(parsed) ? parsed : [];
          }).length,
    );
  await expect.poll(recorded, { timeout: 15_000 }).toBe(2);

  // The page closes before those held calls ever leave it; the next page finds the Ends and finishes them.
  const context = page.context();
  await page.close();
  const next = await context.newPage();
  await next.goto("/");
  await expect
    .poll(() => panes.every((address) => !onCore(address)), { timeout: 20_000, message: "the next page ended them" })
    .toBe(true);
});

test("a tab close whose Ends fail says how many kept running, and where they went", async ({ page }) => {
  const link = await routeHcSocket(page);
  const { panes, tabs } = await twoPaneTab(page);
  kept.push(...panes);
  const release = link.hold("terminal.kill");
  await pressShortcut(page, "tab.close");
  await expect(page.getByRole("tab")).toHaveCount(tabs - 1);
  release(true);
  const toasts = page.getByRole("region", { name: "Notifications" });
  await expect(toasts.getByText(/^2 sessions did not end$/)).toBeVisible({ timeout: 15_000 });
  // The cause reads as its own sentence, and the toast says where the sessions it kept are shown again.
  const description = toasts.getByText(/keeps? running/);
  await expect(description).toHaveText(/\.\s+They keep running outside any tab/);
  await expect(description).toHaveText(/next load/);
});

test("a failed pane End's question says the session keeps running in no pane until the next load", async ({ page }) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  kept.push(address);
  const release = link.hold("terminal.kill");
  await terminal.getByRole("textbox").focus();
  await pressShortcut(page, "pane.close");
  await expect(pane(page, address)).toHaveCount(0);
  release(true);
  const question = page.getByRole("dialog");
  const why = question.getByRole("alert");
  await expect(why).toContainText("The session did not end", { timeout: 15_000 });
  await expect(why).toHaveText(/outside any pane/);
  await expect(why).toHaveText(/next load/);
});
