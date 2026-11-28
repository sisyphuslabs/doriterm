import type { Page } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { rows } from "./sidebar-measure.ts";
import { observeSidebarShifts, sidebarShift } from "./sidebar-shift.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

let address = "";
test.beforeAll(() => {
  address = startAgent("host", "rc-held", "working", "rc206held");
});
test.afterAll(() => endAgent("host", address));

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });
const loading = (page: Page) => sidebar(page).getByRole("status", { name: "Loading machines and spaces" });
const heldRow = (page: Page) =>
  rows(sidebar(page).getByRole("region", { name: "Working", exact: true })).filter({ hasText: "rc-held" });
const machineListIds = (sent: readonly string[]): number[] =>
  sent.flatMap((text) => {
    if (!text.includes('"method":"machine.list"')) return [];
    const id = /"id":(\d+)/.exec(text)?.[1];
    return id === undefined ? [] : [Number(id)];
  });

test("while machine.list is unanswered the agents show, a loading row holds the spaces' place, and nothing moves", async ({
  page,
}) => {
  const socket = await routeHcSocket(page);
  const release = socket.hold("machine.list");
  await page.addInitScript(observeSidebarShifts);
  await page.goto("/");
  await expect(heldRow(page)).toBeVisible({ timeout: 20_000 });
  await expect(loading(page)).toBeVisible();
  release();
  await expect(sidebar(page).locator("[data-machine-header]").first()).toBeVisible({ timeout: 20_000 });
  await expect(loading(page)).toHaveCount(0);
  expect(await sidebarShift(page)).toBe(0);
});

test("an answer that arrives after a newer refresh was sent still draws the machines", async ({ page }) => {
  const socket = await routeHcSocket(page);
  const release = socket.hold("machine.list");
  await page.goto("/");
  await expect(heldRow(page)).toBeVisible({ timeout: 20_000 });
  // The periodic refresh (every 10 s) sends a second machine.list while the first is still unanswered.
  await expect.poll(() => machineListIds(socket.sent()).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  const [, newer] = machineListIds(socket.sent());
  // The newer request is answered never; only the older, slow one comes back.
  socket.holdFromHost(`"id":${newer},`, `"id":${newer}}`);
  release();
  // Within one refresh period, so a later refresh's answer cannot be what draws them.
  await expect(sidebar(page).locator("[data-machine-header]").first()).toBeVisible({ timeout: 5_000 });
  await expect(loading(page)).toHaveCount(0);
});

test("a machine.list that fails replaces the loading row with the error notice", async ({ page }) => {
  const socket = await routeHcSocket(page);
  const release = socket.hold("machine.list");
  await page.goto("/");
  await expect(heldRow(page)).toBeVisible({ timeout: 20_000 });
  await expect(loading(page)).toBeVisible();
  release(true);
  await expect(sidebar(page).getByText("Could not list the machines")).toBeVisible({ timeout: 15_000 });
  await expect(loading(page)).toHaveCount(0);
});
