import { devices } from "@playwright/test";
import { agentRow, startShell } from "./agents.ts";
import { removeTerminal, stateOn } from "./ended-terminal.ts";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import {
  hcOn,
  machineRow,
  reconnect,
  STATE_BOUND_MS,
  switchTo,
  OFFLINE_BOUND_MS,
  OFFLINE_TEST_TIMEOUT_MS,
} from "./machine-switch.ts";
import { fakeSoftKeyboard, key } from "./phone-key-bar.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ ...phone, serviceWorkers: "block" });

test("on a phone, a session that ended while its machine was offline shows as ended, with Close and no terminal keys", async ({
  page,
}) => {
  test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
  const local = startShell("machine", "ended-phone");
  try {
    // The keys bar shows on a touch phone only while the soft keyboard is up.
    await fakeSoftKeyboard(page);
    // The machine reads connected on the Spaces tab (mobile nav phase 3); its agent opens from the Agents tab.
    await page.goto("/?v=spaces");
    await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
    await page
      .getByRole("navigation", { name: "Sections" })
      .getByRole("button", { name: /^Agents\b/ })
      .click();
    await agentRow(page, "ended-phone", true).click();
    const terminal = page.locator(`[data-terminal="${MACHINE_NAME}/${local}"]`);
    await expect(terminal).toContainText("$", { timeout: 15_000 });
    const keys = page.getByRole("toolbar", { name: "Terminal keys" });
    // Opening a terminal leaves the keyboard down, so the bar is the keyboard button's to bring up (#1375).
    await key(page, "Show keyboard").click();
    await expect(keys).toBeVisible();

    // The line to the machine drops and the view stays; the program ends meanwhile, then the machine is back.
    switchTo("drop");
    // #2003 (DORITERM-11): the view stays mounted and the status line says the machine is offline.
    await expect(page.getByRole("status").filter({ hasText: `${MACHINE_NAME} is offline` })).toBeVisible({
      timeout: OFFLINE_BOUND_MS,
    });
    await expect(terminal).toHaveCount(1);
    hcOn("machine", ["kill", local]);
    await expect.poll(() => stateOn("machine", local), { timeout: 15_000 }).toBe("finished");
    reconnect();

    await expect(page.getByRole("heading", { name: "This session ended" })).toBeVisible({ timeout: STATE_BOUND_MS });
    await expect(page.getByText("This terminal didn't open")).toHaveCount(0);
    // One way back (the header's), and the ended view's own action; no keys bar with no terminal to type into.
    await expect(page.getByRole("button", { name: "Back to agents" })).toHaveCount(1);
    await expect(keys).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show keyboard" })).toHaveCount(0);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 15_000 });
  } finally {
    reconnect();
    removeTerminal("machine", local);
  }
});
