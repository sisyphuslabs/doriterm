import { devices, type Page } from "@playwright/test";
import { agentRow, startShell } from "./agents.ts";
import { removeTerminal, stateOn } from "./ended-terminal.ts";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import {
  hcOn,
  machineRow,
  OFFLINE_BOUND_MS,
  reconnect,
  STATE_BOUND_MS,
  switchTo,
  OFFLINE_TEST_TIMEOUT_MS,
} from "./machine-switch.ts";
import { stubSpeech } from "./speech-stub.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ ...phone, serviceWorkers: "block" });

const mic = (page: Page) => page.getByRole("button", { name: /^Dictate into/ });
const strip = (page: Page) => page.locator("[data-voice-strip]");
// The keys bar in either shape (#195): the toolbar with the soft keyboard up, the round button with it down.
const keyBar = (page: Page) =>
  page.getByRole("toolbar", { name: "Terminal keys" }).or(page.getByRole("button", { name: "Show keyboard" }));

/** Opens a shell on the added machine from the phone list, once the machine reads connected. */
async function openOnMachine(page: Page, name: string, address: string) {
  // The machine reads connected on the Spaces tab (mobile nav phase 3); its agent opens from the Agents tab.
  await page.goto("/?v=spaces");
  await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: /^Agents\b/ })
    .click();
  await agentRow(page, name, true).click();
  const terminal = page.locator(`[data-terminal="${MACHINE_NAME}/${address}"]`);
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  return terminal;
}

test("a dictation under way ends when its machine drops: the recognizer is aborted, not left listening", async ({
  page,
}) => {
  test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
  const speech = await stubSpeech(page);
  const address = startShell("machine", "voice-drop");
  try {
    const terminal = await openOnMachine(page, "voice-drop", address);
    await mic(page).click();
    await page.getByRole("button", { name: "Allow" }).click();
    await expect(strip(page)).toHaveAttribute("data-voice-strip", "listening");

    switchTo("drop");
    // #2003 (DORITERM-11): the view stays mounted and the status line says the machine is offline.
    await expect(page.getByRole("status").filter({ hasText: `${MACHINE_NAME} is offline` })).toBeVisible({
      timeout: OFFLINE_BOUND_MS,
    });
    await expect(terminal).toHaveCount(1);
    await expect(page.getByText(`${MACHINE_NAME} is offline`)).toBeVisible();
    await expect(strip(page)).toHaveCount(0);
    await expect(mic(page)).toHaveCount(0);
    await expect.poll(() => speech.aborts()).toBe(1);
  } finally {
    reconnect();
    removeTerminal("machine", address);
  }
});

test("the ended view offers no dictation: no mic, no strip, no keys bar, and a bound Dictate key starts nothing", async ({
  page,
}) => {
  test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
  const speech = await stubSpeech(page);
  const address = startShell("machine", "voice-ended");
  try {
    await page.goto("/settings");
    await page.getByRole("tab", { name: "Keybindings" }).click();
    await page.getByRole("button", { name: "Record a shortcut for Dictate", exact: true }).click();
    await page.keyboard.press("Control+Alt+Shift+D");
    await expect(
      page.locator('[id="keybinding-voice.dictate"]').locator("xpath=../..").getByText("Changed"),
    ).toBeVisible();
    // The speech service, so the bound key would start a real dictation if the ended view still took one.
    await page.getByRole("tab", { name: "Voice input" }).click();
    await page.getByRole("button", { name: "Service", exact: true }).click();
    await expect(page.getByRole("button", { name: "Service", exact: true })).toHaveAttribute("aria-pressed", "true");

    const terminal = await openOnMachine(page, "voice-ended", address);
    switchTo("drop");
    // #2003 (DORITERM-11): the view stays mounted and the status line says the machine is offline.
    await expect(page.getByRole("status").filter({ hasText: `${MACHINE_NAME} is offline` })).toBeVisible({
      timeout: OFFLINE_BOUND_MS,
    });
    await expect(terminal).toHaveCount(1);
    hcOn("machine", ["kill", address]);
    await expect.poll(() => stateOn("machine", address), { timeout: 15_000 }).toBe("finished");
    reconnect();
    await expect(page.getByRole("heading", { name: "This session ended" })).toBeVisible({ timeout: STATE_BOUND_MS });

    await expect(mic(page)).toHaveCount(0);
    await expect(keyBar(page)).toHaveCount(0);
    await expect(strip(page)).toHaveCount(0);
    await page.keyboard.press("Control+Alt+Shift+D");
    await expect(page.getByRole("heading", { name: "This session ended" })).toBeVisible();
    await expect(strip(page)).toHaveCount(0);
    expect(await speech.started()).toEqual([]);
  } finally {
    reconnect();
    removeTerminal("machine", address);
  }
});
