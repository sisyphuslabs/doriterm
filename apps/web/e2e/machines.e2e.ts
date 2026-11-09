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
    // With no terminal to open only the icon dims; the name stays legible (#472, #504). It dims by colour, not by a fade
    // over the icon (#1243): disabled-sidebar-contrast.e2e.ts measures that colour against the 3:1 floor.
    const icon = machineRow(page).locator("svg").first();
    const name = machineRow(page).getByText(MACHINE_NAME, { exact: true });
    await expect(icon).toHaveCSS("opacity", "1");
    await expect(name).toHaveCSS("opacity", "1");
    const [iconInk, nameInk] = await Promise.all(
      [icon, name].map((el) => el.evaluate((e) => getComputedStyle(e).color)),
    );
    expect(iconInk).not.toBe(nameInk);
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
