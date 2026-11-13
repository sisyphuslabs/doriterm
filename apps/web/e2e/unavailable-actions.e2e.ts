// An action that cannot happen now is offered disabled, with its reason, and comes back by itself: never offered and then
// refused (Q, doriterm qa). A space on a machine that went offline can be neither closed nor renamed until it is back.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import {
  machineRow,
  newOn,
  OFFLINE_BOUND_MS,
  OFFLINE_TEST_TIMEOUT_MS,
  reconnect,
  STATE_BOUND_MS,
  switchTo,
} from "./machine-switch.ts";

/** The added machine's own list of spaces in the sidebar, under its header. */
const group = (page: Page) => page.getByRole("region", { name: MACHINE_NAME });

const ACTIONS = [/^Close space/, /^Rename space/];

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

/** The tab strip's New tab, which starts a terminal on the machine of the space in view. */
const newTab = (page: Page) => page.getByRole("button", { name: "New tab" }).first();

/** Opens the "..." menu of the first space listed under the added machine. */
async function openSpaceMenu(page: Page): Promise<void> {
  await group(page)
    .getByRole("button", { name: /^More for / })
    .first()
    .click();
  await expect(page.getByRole("menu")).toBeVisible();
}

test("a space on a machine that went offline offers Close and Rename disabled, and both come back when it reconnects", async ({
  page,
}) => {
  test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
  await page.goto("/");
  await expect(machineRow(page)).toContainText("connected", { timeout: 20_000 });
  await newOn(page).click();
  await expect(group(page).getByRole("button", { name: /^More for / })).not.toHaveCount(0, { timeout: 20_000 });
  try {
    switchTo("off");
    await expect(machineRow(page)).toContainText("offline", { timeout: OFFLINE_BOUND_MS });
    await expect(newTab(page)).toBeDisabled();
    // The phone's + starts the same terminal: at a phone's width it is offered disabled as well.
    await page.setViewportSize(PHONE);
    const phonePlus = page.getByRole("button", { name: "New tab" }).first();
    await expect(phonePlus).toBeVisible();
    await expect(phonePlus).toBeDisabled();
    await page.setViewportSize(DESKTOP);
    await openSpaceMenu(page);
    await Promise.all(
      ACTIONS.map((action) =>
        expect(page.getByRole("menuitem", { name: action })).toHaveAttribute("aria-disabled", "true"),
      ),
    );
    await page.keyboard.press("Escape");
  } finally {
    reconnect();
  }
  await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
  await expect(newTab(page)).toBeEnabled();
  await openSpaceMenu(page);
  await Promise.all(
    ACTIONS.map((action) =>
      expect(page.getByRole("menuitem", { name: action })).not.toHaveAttribute("aria-disabled", "true"),
    ),
  );
});
