import type { Page } from "@playwright/test";
import { agentRow, endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import {
  machineRow,
  reconnect,
  switchOn,
  switchTo,
  OFFLINE_BOUND_MS,
  OFFLINE_TEST_TIMEOUT_MS,
} from "./machine-switch.ts";

/** How long the PAGE may take to show a machine again after its line came back: hc's redial backoff after a few refused
 * dials, plus one machine.list read. A page-side bound, unlike machine-switch.ts's REDIAL_BOUND_MS on the core itself. */
const PAGE_REDIAL_BOUND_MS = 45_000;

const statusCount = (page: Page) => page.getByRole("contentinfo").getByText(/^\d+ terminals?\b/);

test.describe("a machine whose line drops while its terminals keep running", () => {
  let address = "";
  test.beforeEach(() => {
    address = startAgent("machine", "crunch", "working");
  });
  test.afterEach(() => {
    reconnect();
    endAgent("machine", address);
  });

  test("its sessions stop reading live and Working, and leave the live counts", async ({ page }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    await page.goto("/");
    const working = page.getByRole("region", { name: "Working" });
    await expect(agentRow(working, "crunch", true)).toBeVisible({ timeout: 20_000 });
    await expect(machineRow(page)).toContainText(/connected\s*1/);
    const before = Number.parseInt((await statusCount(page).textContent()) ?? "", 10);

    switchTo("drop");
    await expect(machineRow(page)).toContainText(/offline\s*0/, { timeout: OFFLINE_BOUND_MS });
    await expect(working.getByRole("button", { name: /crunch/ })).toHaveCount(0);
    const row = agentRow(page.getByRole("region", { name: "Offline" }), "crunch", true);
    await expect(row.getByRole("img", { name: "Unknown" })).toBeVisible();
    await expect(statusCount(page)).toHaveText(new RegExp(`^${before - 1} terminals?\\b`));
  });

  test("when the machine answers again its sessions come back as Working, with no reload", async ({ page }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    await page.goto("/");
    const working = page.getByRole("region", { name: "Working" });
    await expect(agentRow(working, "crunch", true)).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => Object.assign(window, { sameDocument: true }));

    switchTo("drop");
    await expect(page.getByRole("region", { name: "Offline" })).toBeVisible({ timeout: OFFLINE_BOUND_MS });
    switchOn();
    await expect(agentRow(working, "crunch", true)).toBeVisible({ timeout: PAGE_REDIAL_BOUND_MS });
    await expect(page.getByRole("region", { name: "Offline" })).toHaveCount(0);
    await expect(machineRow(page)).toContainText(/connected\s*1/);
    expect(await page.evaluate(() => "sameDocument" in window)).toBe(true);
  });
});
