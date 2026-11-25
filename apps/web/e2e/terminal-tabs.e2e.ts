import type { Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

interface Layout {
  readonly open: readonly (string | null)[];
  readonly active: string | null;
}

/** Every open tab mounts its terminal, so the mounted addresses are the tab list and the focused pane is the active one. */
const layout = (page: Page): Promise<Layout> =>
  page.evaluate(() => ({
    open: [...document.querySelectorAll("[data-terminal]")].map((el) => el.getAttribute("data-terminal")),
    active: document.querySelector('[data-focused="true"] [data-terminal]')?.getAttribute("data-terminal") ?? null,
  }));

/** Two new tabs, the last one active, so falling back to the first tab is visible. */
async function twoTabs(page: Page): Promise<Layout> {
  await openNewTerminal(page);
  await openNewTerminal(page);
  const before = await layout(page);
  expect(before.open.length).toBeGreaterThanOrEqual(2);
  expect(before.active).toBe(before.open.at(-1));
  return before;
}

async function runsInActive(page: Page, before: Layout, marker: number): Promise<void> {
  const terminal = page.locator(`[data-focused="true"] [data-terminal="${before.active}"]`);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`echo tab-$((${marker}+1))`);
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(`tab-${marker + 1}`, { timeout: 15_000 });
}

test("open tabs and the active terminal survive a reconnect", async ({ page }) => {
  const socket = await routeHcSocket(page);
  await page.goto("/");
  const before = await twoTabs(page);
  const opened = socket.opened();
  await socket.drop(false);
  await expect.poll(socket.opened, { timeout: 15_000 }).toBeGreaterThan(opened);
  await expect.poll(() => layout(page), { timeout: 15_000 }).toEqual(before);
  await runsInActive(page, before, 100);
});

test("open tabs and the active terminal survive Settings and Back", async ({ page }) => {
  await page.goto("/");
  const before = await twoTabs(page);
  await page.getByRole("complementary", { name: "Workspace" }).getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Close settings" }).first().click();
  await expect.poll(() => layout(page), { timeout: 15_000 }).toEqual(before);
  await runsInActive(page, before, 200);
});

test("open tabs and the active terminal survive crossing the phone breakpoint and back", async ({ page }) => {
  await page.goto("/");
  const before = await twoTabs(page);
  const wide = page.viewportSize() ?? { width: 1280, height: 720 };
  // Under the compact tier's 600 px (apps/web/src/layout/width-tier.ts).
  await page.setViewportSize({ width: 500, height: wide.height });
  await expect(page.getByRole("tablist", { name: "Tabs" })).toBeHidden();
  await page.setViewportSize(wide);
  await expect.poll(() => layout(page), { timeout: 15_000 }).toEqual(before);
  await runsInActive(page, before, 300);
});
