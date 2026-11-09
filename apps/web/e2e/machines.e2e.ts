import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import {
  machineRow,
  newOn,
  STATE_BOUND_MS,
  reconnect,
  switchTo,
  OFFLINE_BOUND_MS,
  OFFLINE_TEST_TIMEOUT_MS,
} from "./machine-switch.ts";

test.describe("machines added with hc machine add", () => {
  test("a redial reads reconnecting in Spaces and Machines, blocks create, then creates on recovery", async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(newOn(page)).toBeEnabled({ timeout: 20_000 });
    try {
      switchTo("drop");
      await expect(machineRow(page)).toContainText("reconnecting", { timeout: STATE_BOUND_MS });
      await expect(newOn(page)).toBeDisabled();
      await page.screenshot({ path: testInfo.outputPath("spaces-reconnecting.png") });
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Machines", exact: true }).click();
      const row = page.getByRole("list", { name: "Machines", exact: true }).getByRole("listitem").filter({
        hasText: MACHINE_NAME,
      });
      await expect(row).toContainText("Reconnecting");
      await page.screenshot({ path: testInfo.outputPath("machines-reconnecting.png") });
      reconnect();
      await expect(row).toContainText("Connected", { timeout: STATE_BOUND_MS });
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await expect(newOn(page)).toBeEnabled();
      await newOn(page).click();
      const focused = page.locator('[data-focused="true"] [data-terminal]');
      await expect(focused).toHaveAttribute("data-terminal", new RegExp(`^${MACHINE_NAME}/t[0-9a-z]+$`));
      await focused.click();
      await page.keyboard.type("echo recovered-$((40 + 2))\r");
      await expect(focused).toContainText("recovered-42");
      await page.screenshot({ path: testInfo.outputPath("new-space-recovered.png") });
      await page.keyboard.type("exit\r");
      expect(errors).toEqual([]);
    } finally {
      reconnect();
    }
  });

  test("New terminal on a machine starts its shell there and attaches it at machine/tN", async ({ page }) => {
    await page.goto("/");
    await expect(machineRow(page)).toContainText("connected", { timeout: 20_000 });
    await newOn(page).click({ force: true });
    const focused = page.locator('[data-focused="true"] [data-terminal]');
    await expect(focused).toHaveAttribute("data-terminal", new RegExp(`^${MACHINE_NAME}/t[0-9a-z]+$`), {
      timeout: 15_000,
    });
    const address = await focused.getAttribute("data-terminal");
    // A tab carries no machine tag, as its space is one machine's (#404): the status bar's machine item carries the full
    // hc address the old pane header showed.
    await expect(page.getByRole("contentinfo").locator("[data-status-machine] [title]")).toHaveText(
      address ?? "missing",
    );
    await focused.click();
    await page.keyboard.type("echo on-build-box-$((40 + 2))\r");
    await expect(focused).toContainText("on-build-box-42", { timeout: 15_000 });
    await page.keyboard.type("exit\r");
    await expect(machineRow(page)).toContainText(/connected\s*0/, { timeout: 15_000 });
    await expect(machineRow(page)).toBeDisabled();
    // With no terminal to open only the icon dims; the name stays legible (#472, #504).
    await expect(machineRow(page).locator("svg").first()).toHaveCSS("opacity", "0.45");
    await expect(machineRow(page).getByText(MACHINE_NAME, { exact: true })).toHaveCSS("opacity", "1");
  });

  test("a machine that goes offline with the page open reads offline and offers no new terminal", async ({ page }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(machineRow(page)).toContainText("connected", { timeout: 20_000 });
    try {
      switchTo("off");
      await expect(machineRow(page)).toContainText("offline", { timeout: OFFLINE_BOUND_MS });
      await expect(newOn(page)).toBeDisabled();
      expect(errors).toEqual([]);
    } finally {
      // Dialed now, not after hc's redial backoff (up to 30 s): the next spec in this worker finds the machine connected.
      reconnect();
    }
  });

  test("a machine that asks for a login reads needs login in the attention tone", async ({ page }) => {
    await page.goto("/");
    await expect(machineRow(page)).toContainText("connected", { timeout: 20_000 });
    try {
      switchTo("login");
      const state = machineRow(page).getByText("needs login", { exact: true });
      await expect(state).toBeVisible({ timeout: STATE_BOUND_MS });
      await expect(state).toHaveClass(/text-status-blocked-text/);
      await expect(state).toHaveCSS("opacity", "1");
      await expect(newOn(page)).toBeDisabled();
    } finally {
      // Dialed now, not after hc's redial backoff (up to 30 s): the next spec in this worker finds the machine connected.
      reconnect();
    }
  });
});
