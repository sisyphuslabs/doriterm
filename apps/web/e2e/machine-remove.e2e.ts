import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { DEMO_MACHINE, MACHINE_ENV, MACHINE_NAME, viaCommand } from "./machine.ts";
import {
  hcOn,
  machineRow,
  machineState,
  OFFLINE_BOUND_MS,
  OFFLINE_TEST_TIMEOUT_MS,
  reconnect,
  STATE_BOUND_MS,
  switchOn,
  switchTo,
} from "./machine-switch.ts";
import { pressShortcut } from "./platform-keys.ts";
import { readSavedEnv } from "./saved-env.ts";

// A machine added by hand is removed from the app (#2456): one Remove entry where its problem is seen (its offline
// notice, its header's menu, its Settings > Machines row), one confirmation, and it leaves every list because it
// leaves the core's machine list itself.

test.use({ serviceWorkers: "block" });

const QUESTION = `Remove ${MACHINE_NAME}?`;
const SAYS = "Its spaces leave this list; anything running there keeps running.";
/** The remover's own page re-reads machine.list once the remove is answered: no periodic read is waited for. */
const AT_ONCE_MS = 5_000;

const group = (page: Page) =>
  page.getByRole("region", { name: "Spaces" }).getByRole("region", { name: MACHINE_NAME, exact: true });
/** The header's handle: the menu opens on it, also while the header has no terminal to open (aria-disabled). */
const headerHandle = (page: Page) => page.locator("[data-machine-row]", { has: machineRow(page) });
const settingsRow = (page: Page) =>
  page.getByRole("list", { name: "Machines" }).getByRole("listitem").filter({ hasText: MACHINE_NAME });

async function openSettingsMachines(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Machines" }).click();
  await expect(page.getByRole("heading", { name: "Machines", level: 2 })).toBeVisible();
}

test.describe("removing a machine added by hand", () => {
  test.afterEach(() => {
    switchOn();
    // A spec that removed the machine adds it back as the e2e host first did, so the next spec finds it.
    if (machineState() === undefined) {
      const via = viaCommand(readSavedEnv(MACHINE_ENV).env, DEMO_MACHINE);
      hcOn("host", ["machine", "add", "--via", via, "--name", MACHINE_NAME]);
    } else reconnect();
  });

  test("its offline notice offers Remove beside Try again; once confirmed it leaves the sidebar and Settings at once, on every device", async ({
    page,
  }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    const other = await page.context().newPage();
    await page.goto("/");
    await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
    await openSettingsMachines(other);
    await expect(settingsRow(other)).toContainText("Connected", { timeout: STATE_BOUND_MS });

    switchTo("drop");
    const notice = group(page).getByRole("status").filter({ hasText: "offline" });
    await expect(notice).toBeVisible({ timeout: OFFLINE_BOUND_MS });
    await expect(notice.getByRole("button", { name: "Try again" })).toBeVisible();
    await notice.getByRole("button", { name: `Remove ${MACHINE_NAME}…` }).click();

    const dialog = page.getByRole("dialog", { name: QUESTION });
    await expect(dialog).toContainText(SAYS);
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: AT_ONCE_MS });
    await expect(group(page)).toHaveCount(0, { timeout: AT_ONCE_MS });
    expect(machineState()).toBeUndefined();
    // The other device reads the core's machine list, which no longer has it.
    await expect(settingsRow(other)).toHaveCount(0, { timeout: STATE_BOUND_MS });
    await openSettingsMachines(page);
    await expect(page.getByRole("list", { name: "Machines" })).toBeVisible();
    await expect(settingsRow(page)).toHaveCount(0);
  });

  test("its header menu offers Remove, and Cancel keeps the machine", async ({ page }) => {
    await page.goto("/");
    await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
    await headerHandle(page).click({ button: "right" });
    await page.getByRole("menuitem", { name: `Remove ${MACHINE_NAME}…` }).click();
    const dialog = page.getByRole("dialog", { name: QUESTION });
    await expect(dialog).toContainText(SAYS);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(machineState()).toBe("connected");
    await expect(group(page)).toBeVisible();
  });

  test("its header menu offers Remove while the sidebar is filtered, where the group cannot move (#2503 review)", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
    await pressShortcut(page, "layout.filter:sidebar");
    await page.getByRole("searchbox", { name: "Filter sidebar" }).fill(MACHINE_NAME);
    await expect(group(page)).not.toHaveAttribute("data-drag-id");
    await headerHandle(page).click({ button: "right" });
    await page.getByRole("menuitem", { name: `Remove ${MACHINE_NAME}…` }).click();
    const dialog = page.getByRole("dialog", { name: QUESTION });
    await expect(dialog).toContainText(SAYS);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(machineState()).toBe("connected");
  });

  test("its Settings, Machines row offers Remove, and the row leaves once confirmed", async ({ page }) => {
    await openSettingsMachines(page);
    const row = settingsRow(page);
    await expect(row).toContainText("Connected", { timeout: STATE_BOUND_MS });
    await row.getByRole("button", { name: `Remove ${MACHINE_NAME}…` }).click();
    const dialog = page.getByRole("dialog", { name: QUESTION });
    await expect(dialog).toContainText(SAYS);
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(row).toHaveCount(0, { timeout: AT_ONCE_MS });
    expect(machineState()).toBeUndefined();
  });
});
