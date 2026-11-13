// An action that cannot happen now is offered disabled, with its reason, and comes back by itself: never offered and then
// refused (Q, doriterm qa). A space on a machine that went offline can be neither closed nor renamed until it is back.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { MACHINE_NAME } from "./machine.ts";
import {
  hcOn,
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

/** The first space row under the added machine: a button that is none of its header's (the row, New space, fold). */
/** The space seeded into the added machine's own layout document, so it is listed (and owned) under that machine. */
const SPACE = "on-the-machine";
const spaceRowIn = (page: Page) => group(page).getByRole("button", { name: new RegExp(`^${SPACE}\\b`) });

const ACTIONS = [/^Close space/, /^Rename space/];

/** The seeded space's one tab, in the strip once the space is in view. */
const tabIn = (page: Page) =>
  page.getByRole("tablist", { name: "Tabs" }).getByRole("tab", { name: new RegExp(`\\b${SPACE}\\b`) });
const tabRename = (page: Page) => page.getByRole("dialog", { name: `Rename ${SPACE}` });

/** Opens the "..." menu of the first space listed under the added machine. */
async function openSpaceMenu(page: Page): Promise<void> {
  await expect(page.getByRole("menu")).toHaveCount(0);
  // A space row shows its "..." only while it is hovered (as space-close.e2e.ts opens it), named for the space itself.
  const row = spaceRowIn(page);
  await row.hover();
  await page.getByRole("button", { name: `More for ${SPACE}` }).click();
  await expect(page.getByRole("menu")).toBeVisible();
}

test("a space on a machine that went offline offers Close and Rename disabled, and both come back when it reconnects", async ({
  page,
}) => {
  test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
  // A terminal on the added machine, in a space its own layout document holds: Q's case, a space owned by the machine.
  const started: unknown = JSON.parse(
    hcOn("machine", ["run", "--bg", "--name", "unavailable", "--", "env", "PS1=$ ", "sh"]),
  );
  const local = typeof started === "object" && started !== null ? String(Reflect.get(started, "address")) : "";
  seedSpaces(
    [{ id: `spc-${SPACE}`, name: SPACE, folder: "/tmp", tabs: [{ id: `tb-${SPACE}`, name: SPACE, terminal: local }] }],
    MACHINE_NAME,
  );
  await page.goto("/");
  await expect(machineRow(page)).toContainText("connected", { timeout: 20_000 });
  await expect(spaceRowIn(page)).toBeVisible({ timeout: 20_000 });
  try {
    // The line goes away while the machine and its terminals keep running, as when its network drops: its space stays
    // listed under it, as in the reported screen, and the machine reads offline once the reconnect grace has passed.
    switchTo("drop");
    await expect(machineRow(page)).toContainText("offline", { timeout: OFFLINE_BOUND_MS });
    // What is aimed at the offline machine itself is offered disabled: its header's +, and its space's Close and Rename.
    // (The strip's New tab follows the tab in view, which may be another machine's, so it is not asserted here.)
    await expect(newOn(page)).toBeDisabled();
    await openSpaceMenu(page);
    await Promise.all(
      ACTIONS.map((action) =>
        expect(page.getByRole("menuitem", { name: action })).toHaveAttribute("aria-disabled", "true"),
      ),
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    // The space's tab can still be asked to rename (its name is in view), but the question waits: Rename disabled, why
    // and what comes next in one neutral line, and no error, since nothing was written (Q's QA shot, #2455).
    await spaceRowIn(page).click();
    await tabIn(page).dblclick();
    const question = tabRename(page);
    await expect(question).toBeVisible();
    await expect(question.getByRole("button", { name: "Rename" })).toBeDisabled();
    await expect(question.getByText(/comes back by itself once the machine can take it/)).toBeVisible();
    await expect(question.locator(".text-destructive")).toHaveCount(0);
  } finally {
    reconnect();
  }
  // The question left open comes back by itself once the machine is back (the modal question hides the sidebar's row):
  // Rename enabled, its waiting line gone.
  await expect(tabRename(page).getByRole("button", { name: "Rename" })).toBeEnabled({ timeout: STATE_BOUND_MS });
  await expect(tabRename(page).getByText(/comes back by itself/)).toHaveCount(0);
  await tabRename(page).getByRole("button", { name: "Cancel" }).click();
  await expect(tabRename(page)).toHaveCount(0);
  await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
  await expect(newOn(page)).toBeEnabled();
  await openSpaceMenu(page);
  await Promise.all(
    ACTIONS.map((action) =>
      expect(page.getByRole("menuitem", { name: action })).not.toHaveAttribute("aria-disabled", "true"),
    ),
  );
});
