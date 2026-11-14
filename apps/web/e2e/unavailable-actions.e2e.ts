// An action that cannot happen now is offered disabled, with its reason, and comes back by itself: never offered and then
// refused (Q, doriterm qa). A space on a machine that went offline can be neither closed nor renamed until it is back.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
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
import { pressShortcut } from "./platform-keys.ts";

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
}, testInfo) => {
  test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
  await page.setViewportSize({ width: 1440, height: 900 });
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
    await expect(
      question.getByText(
        `The layout cannot take changes now: ${MACHINE_NAME} is offline. Rename comes back by itself once the machine can take it.`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(question.locator(".text-destructive")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("offline-rename-1440.png") });
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

test("on a phone, an offline machine's space offers New tab disabled with why, and it comes back when the machine reconnects", async ({
  page,
}, testInfo) => {
  test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneSpace = "on-the-phone";
  const started: unknown = JSON.parse(
    hcOn("machine", ["run", "--bg", "--name", "unavailable-phone", "--", "env", "PS1=$ ", "sh"]),
  );
  const local = typeof started === "object" && started !== null ? String(Reflect.get(started, "address")) : "";
  seedSpaces(
    [
      {
        id: `spc-${phoneSpace}`,
        name: phoneSpace,
        folder: "/tmp",
        tabs: [{ id: `tb-${phoneSpace}`, name: phoneSpace, terminal: local }],
      },
    ],
    MACHINE_NAME,
  );
  await page.goto("/?v=spaces");
  await page.getByText(phoneSpace).first().click({ timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: phoneSpace })).toBeVisible({ timeout: 10_000 });
  // The space screen's own New tab, at the bottom within thumb reach: a path of its own, apart from the strip's +.
  const newTab = page.getByRole("button", { name: `New tab in ${phoneSpace}` });
  await expect(newTab).toBeEnabled({ timeout: 20_000 });
  try {
    switchTo("drop");
    await expect(newTab).toBeDisabled({ timeout: OFFLINE_BOUND_MS });
    // The button can wait during the grace too; the offline reason is due only once that grace has ended.
    await expect(
      page.getByText(
        `The layout cannot take changes now: ${MACHINE_NAME} is offline. New tab comes back by itself once the machine can take it.`,
        { exact: true },
      ),
    ).toBeVisible({ timeout: OFFLINE_BOUND_MS });
    await page.screenshot({ path: testInfo.outputPath("offline-space-390.png") });
  } finally {
    reconnect();
  }
  await expect(newTab).toBeEnabled({ timeout: STATE_BOUND_MS });
  await expect(page.getByText(/comes back by itself/)).toHaveCount(0);
});

/** Seeds space `name` into the added machine's own layout, one tab on a terminal there; an absent terminal leaves it empty. */
function seedMachineSpace(name: string, terminal?: string): void {
  const address =
    terminal ??
    String(
      Reflect.get(JSON.parse(hcOn("machine", ["run", "--bg", "--name", name, "--", "env", "PS1=$ ", "sh"])), "address"),
    );
  seedSpaces(
    [{ id: `spc-${name}`, name, folder: "/tmp", tabs: [{ id: `tb-${name}`, name, terminal: address }] }],
    MACHINE_NAME,
  );
}

test("a Close question left open as its machine drops waits with Close disabled and why, and the New tab key asks nothing while it is down", async ({
  page,
}) => {
  test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
  const name = "close-waits";
  seedMachineSpace(name);
  const socket = await routeHcSocket(page);
  await page.goto("/");
  await expect(machineRow(page)).toContainText("connected", { timeout: 20_000 });
  const row = group(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });
  await expect(row).toBeVisible({ timeout: 20_000 });
  // The space's tab is the one in view, so New tab and its key aim at the machine about to drop.
  await row.click();
  await row.hover();
  await page.getByRole("button", { name: `More for ${name}` }).click();
  await page.getByRole("menuitem", { name: /^Close space/ }).click();
  const question = page.getByRole("dialog", { name: "Close space?" });
  const close = question.getByRole("button", { name: "Close" });
  await expect(close).toBeEnabled();
  try {
    switchTo("drop");
    await expect(close).toBeDisabled({ timeout: OFFLINE_BOUND_MS });
    await expect(question.getByText(/Close comes back by itself once the machine can take it/)).toBeVisible();
    await expect(question.getByText("The space was not closed")).toHaveCount(0);
    await question.getByRole("button", { name: "Cancel" }).click();
    await expect(question).toHaveCount(0);
    // The key does what the disabled button does: nothing. Keys are handled in order, so once the palette (asked for
    // after it) is open, a New tab the key started has already sent its run to the core.
    const runs = (): number => socket.sent().filter((frame) => frame.includes('"method":"terminal.run"')).length;
    const before = runs();
    await pressShortcut(page, "tab.new");
    await pressShortcut(page, "app.palette");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    expect(runs(), "the New tab key asks the core nothing while New tab is disabled").toBe(before);
    await expect(page.getByRole("heading", { name: "Could not open a new tab" })).toHaveCount(0);
    await page.keyboard.press("Escape");
  } finally {
    reconnect();
  }
  await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
});

test("on a phone, an offline machine's empty space offers New tab here and Close space disabled with why", async ({
  page,
}) => {
  test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
  await page.setViewportSize({ width: 390, height: 844 });
  const name = "nothing-running";
  // A tab on a terminal that does not run: the space screen shows its empty state.
  seedMachineSpace(name, "t99999");
  await page.goto("/?v=spaces");
  await page.getByText(name).first().click({ timeout: 20_000 });
  await expect(page.getByText(`Nothing is running in ${name}`)).toBeVisible({ timeout: 20_000 });
  const newHere = page.getByRole("button", { name: "New tab here" });
  const closeSpace = page.getByRole("button", { name: "Close space" });
  await expect(newHere).toBeEnabled();
  try {
    switchTo("drop");
    await expect(newHere).toBeDisabled({ timeout: OFFLINE_BOUND_MS });
    await expect(closeSpace).toBeDisabled();
    await expect(page.getByText(/New tab here and Close space come back by themselves/)).toBeVisible();
  } finally {
    reconnect();
  }
  await expect(newHere).toBeEnabled({ timeout: STATE_BOUND_MS });
  await expect(closeSpace).toBeEnabled();
});
