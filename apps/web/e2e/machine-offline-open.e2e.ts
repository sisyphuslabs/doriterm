import { agentRow, endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { machineRow, reconnect, STATE_BOUND_MS, switchOn, switchTo } from "./machine-switch.ts";

const OFFLINE = `${MACHINE_NAME} is offline`;

test.describe("opening a session on a machine that went offline", () => {
  let address = "";
  test.beforeEach(() => {
    address = startAgent("machine", "crunch", "working");
  });
  test.afterEach(() => {
    reconnect();
    endAgent("machine", address);
  });

  test("says why in plain words, and Try again brings the terminal back", async ({ page }) => {
    await page.goto("/");
    await expect(agentRow(page, "crunch", true)).toBeVisible({ timeout: 20_000 });
    switchTo("drop");
    await expect(machineRow(page)).toContainText("offline", { timeout: STATE_BOUND_MS });
    await expect(page.getByRole("status").filter({ hasText: OFFLINE }).first()).toBeVisible();

    await agentRow(page, "crunch", true).click();
    const pane = page.locator('[data-focused="true"]');
    await expect(pane.getByRole("heading", { name: OFFLINE })).toBeVisible({ timeout: 15_000 });
    await expect(pane).not.toContainText(/HcRpcError|cannot reach|sh -c|Working/);

    switchOn();
    await pane.getByRole("button", { name: "Try again" }).click();
    await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
    await expect(pane.locator(`[data-terminal="${MACHINE_NAME}/${address}"]`)).toBeVisible({ timeout: 15_000 });
  });

  test("offers a phone no terminal keys, as there is nothing to type into", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(agentRow(page, "crunch", true)).toBeVisible({ timeout: 20_000 });
    switchTo("drop");
    await expect(page.getByRole("region", { name: "Offline" })).toBeVisible({ timeout: STATE_BOUND_MS });
    await agentRow(page, "crunch", true).click();
    await expect(page.getByRole("heading", { name: OFFLINE })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("toolbar", { name: "Terminal keys" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show keyboard" })).toHaveCount(0);
  });
});
