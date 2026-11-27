import type { Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

// #403: a link that dropped, then Settings and back while the page reconnects. The workspace that comes back must show
// what the page had (the terminals and their panes), not an empty list and "Waiting for this terminal to start" until a
// reconnect lands, and it must not wait out a long back-off to reconnect.

const RECONNECTING = /Reconnecting/;
const notice = (page: Page, text: RegExp) => page.getByRole("status").filter({ hasText: text });
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });

async function echoes(page: Page, marker: string): Promise<void> {
  const terminal = page.locator("[data-terminal]").filter({ visible: true }).first();
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`echo ${marker}-$((2+3))`);
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(`${marker}-5`, { timeout: 20_000 });
}

/** Settings and back, inside the app: the workspace stays mounted under Settings, the page does not reload. */
async function settingsRoundTrip(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Settings" }).first().click();
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).first().click();
  await expect(sidebar(page)).toBeVisible();
}

test("while the link is down, Settings and back keeps the terminal list and panes, and the shell answers once it is back", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const socket = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  await echoes(page, "before-drop");
  await socket.drop(true);
  await expect.poll(socket.refused, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

  await settingsRoundTrip(page);
  await expect(sidebar(page).locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(page.getByText("Waiting for this terminal to start")).toHaveCount(0);
  await expect(page.locator("[data-terminal]").filter({ visible: true })).toHaveCount(1);

  socket.restore();
  await expect(notice(page, RECONNECTING)).toHaveCount(0, { timeout: 15_000 });
  await echoes(page, "after-round-trip");
});

test("Settings and back keeps the terminal it showed: no reattach, no replay, and the keyboard back in it", async ({
  page,
}) => {
  await page.goto("/");
  await openNewTerminal(page);
  await echoes(page, "before-settings");
  const terminal = page.locator("[data-terminal]").filter({ visible: true }).first();
  // The element itself is marked: a workspace that mounted again draws a new one, which replays the whole history.
  await terminal.evaluate((element) => element.setAttribute("data-kept", ""));

  await settingsRoundTrip(page);
  await expect(page.locator("[data-terminal][data-kept]").filter({ visible: true })).toHaveCount(1);
  await expect(terminal.getByRole("textbox")).toBeFocused();
  await echoes(page, "after-settings");
});

test("coming back from Settings while a reconnect waits out its back-off reconnects at once, on one new socket", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const socket = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  const opened = socket.opened();
  await socket.drop(true);
  // Four refused attempts (0.5 + 1 + 2 + 5 s) leave the next one 10 s away.
  await expect.poll(socket.refused, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  await expect(notice(page, /Reconnecting in ([6-9]|10) s/)).toBeVisible({ timeout: 5_000 });
  socket.restore();

  await settingsRoundTrip(page);
  await expect(notice(page, RECONNECTING)).toHaveCount(0, { timeout: 3_000 });
  expect(socket.opened() - opened).toBe(1);
  await echoes(page, "back-from-settings");
});
