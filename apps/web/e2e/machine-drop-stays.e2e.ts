// #2464: the machine of the terminal in view drops. The view stays on that terminal's tab: it says it is reconnecting
// beside the terminal, never over its output, and comes back by itself; a machine that stays gone reads offline in the
// same place with one way on. A drop never moves the person to another tab.
import type { Locator, Page } from "@playwright/test";
import { agentRow, startShell } from "./agents.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { ACTION_GRACE_MS } from "../src/workspace/machine-grace.ts";
import { MACHINE_NAME } from "./machine.ts";
import {
  blip,
  hcOn,
  machineRow,
  machineState,
  newOn,
  OFFLINE_BOUND_MS,
  OFFLINE_TEST_TIMEOUT_MS,
  reconnect,
  REDIAL_BOUND_MS,
  STATE_BOUND_MS,
  switchTo,
} from "./machine-switch.ts";

test.use({ serviceWorkers: "block" });

const focused = (page: Page) => page.locator('[data-focused="true"] [data-terminal]');
const selectedTab = (page: Page) => page.locator('[data-tab-id]:has([role="tab"][aria-selected="true"])');

/**
 * Records, from now on, every tab the page selects and every terminal it focuses other than `address`. A
 * MutationObserver sees each change as it renders, so a swap shorter than any poll is recorded too.
 */
async function recordSwaps(page: Page, address: string): Promise<void> {
  await page.evaluate((kept) => {
    const swaps: string[] = [];
    const first = document.querySelector('[role="tab"][aria-selected="true"]')?.closest("[data-tab-id]");
    const tab = first?.getAttribute("data-tab-id") ?? "none";
    const check = (): void => {
      const now = document.querySelector('[role="tab"][aria-selected="true"]')?.closest("[data-tab-id]");
      // The phone shows no tab strip: only a strip that selects another tab is a swap.
      const id = now?.getAttribute("data-tab-id");
      if (id != null && id !== tab) swaps.push(`tab: ${id}`);
      const shown = document.querySelector('[data-focused="true"] [data-terminal]')?.getAttribute("data-terminal");
      if (shown != null && shown !== kept) swaps.push(`terminal: ${shown}`);
    };
    new MutationObserver(check).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    Object.assign(window, { swaps });
  }, address);
}

const swaps = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...new Set((window as unknown as { swaps: string[] }).swaps)]);

async function overlap(a: Locator, b: Locator): Promise<boolean> {
  const [one, two] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  if (one === null || two === null) throw new Error("an element is not laid out");
  return (
    one.x < two.x + two.width && two.x < one.x + one.width && one.y < two.y + two.height && two.y < one.y + one.height
  );
}

/** The element is drawn whole inside the window: a one-line bar item that overflows it would lose its end. */
async function shownWhole(element: Locator): Promise<boolean> {
  const box = await element.boundingBox();
  const width = element.page().viewportSize()?.width ?? 0;
  return box !== null && box.x >= 0 && box.x + box.width <= width;
}

/** The page as it is now, for the pull request's before and after. */
const capture = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

/** A local tab to swap to, then a shell on the added machine in its own space, in view: its address. */
async function remoteInView(page: Page): Promise<string> {
  await page.goto("/");
  await openNewTerminal(page);
  await expect(machineRow(page)).toContainText("connected", { timeout: 20_000 });
  await newOn(page).click({ force: true });
  const remote = new RegExp(`^${MACHINE_NAME}/t[0-9a-z]+$`);
  await expect(focused(page)).toHaveAttribute("data-terminal", remote, { timeout: 15_000 });
  const address = (await focused(page).getAttribute("data-terminal")) ?? "";
  await expect(page.locator(`[data-terminal="${address}"]`)).toContainText("$", { timeout: 15_000 });
  return address;
}

test.describe("the terminal in view when its machine drops (#2464)", () => {
  let remote = "";
  let split = "";
  test.afterEach(() => {
    reconnect();
    for (const address of [remote, split])
      if (address !== "") hcOn("machine", ["kill", address.slice(MACHINE_NAME.length + 1)]);
    remote = "";
    split = "";
  });

  test("a two-second drop keeps its tab in view and says Reconnecting beside the terminal", async ({ page }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    remote = await remoteInView(page);
    const terminal = page.locator(`[data-terminal="${remote}"]`);
    const tab = await selectedTab(page).getAttribute("data-tab-id");
    await recordSwaps(page, remote);

    const back = blip(2_000);
    await expect.poll(machineState, { timeout: 5_000 }).toBe("unreachable");
    const status = page.getByRole("status").filter({ hasText: `Reconnecting to ${MACHINE_NAME}` });
    await expect(status.first()).toBeVisible({ timeout: STATE_BOUND_MS });
    await expect(terminal).toBeVisible();
    const overlaps = await Promise.all((await status.all()).map((shown) => overlap(shown, terminal)));
    expect(overlaps).not.toContain(true);
    await back;
    reconnect();
    await expect.poll(machineState, { timeout: STATE_BOUND_MS }).toBe("connected");
    await expect(status).toHaveCount(0, { timeout: STATE_BOUND_MS });

    expect(await swaps(page)).toEqual([]);
    await expect(selectedTab(page)).toHaveAttribute("data-tab-id", tab ?? "");
    await expect(focused(page)).toHaveAttribute("data-terminal", remote);
  });

  test("a machine that stays gone reads offline in the same tab, with one action", async ({ page }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    remote = await remoteInView(page);
    const tab = await selectedTab(page).getAttribute("data-tab-id");
    await recordSwaps(page, remote);

    switchTo("drop");
    await expect.poll(machineState, { timeout: 5_000 }).toBe("unreachable");
    const status = page.getByRole("status").filter({ hasText: `Reconnecting to ${MACHINE_NAME}` });
    await expect(status.first()).toBeVisible({ timeout: STATE_BOUND_MS });
    await capture(page, "reconnecting-desktop");
    const bar = page.getByRole("contentinfo");
    await expect(bar).not.toContainText("Connected");
    // Past the 5 s grace the bar says why, beside one Try again, while hc keeps redialing (the 2464 review): no warning
    // is raised (#1686), and the machine reads offline only once its redial grace is over (#904).
    const down = bar.locator("[data-machine-down]");
    await expect(down).toContainText(MACHINE_NAME, { timeout: ACTION_GRACE_MS + STATE_BOUND_MS });
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(1);
    expect(await shownWhole(down)).toBe(true);
    const pane = page.locator('[data-focused="true"]');
    await expect(pane.getByText(`${MACHINE_NAME} is offline`)).toHaveCount(0);
    await capture(page, "machine-down-desktop");
    await expect(pane.getByText(`${MACHINE_NAME} is offline`)).toBeVisible({ timeout: OFFLINE_BOUND_MS });
    // One way to try now; a machine added by hand also offers Remove beside it (#2456), which is not a retry.
    await expect(pane.getByRole("button", { name: "Try again" })).toHaveCount(1);
    await expect(pane.getByRole("button")).toHaveText(["Try again", /^Remove/]);
    // The page's own link is up, but beside the machine's name the bar speaks for the machine: it is offline.
    await expect(down).toHaveCount(0);
    await expect(bar).toContainText(`${MACHINE_NAME} is offline`);
    await expect(bar).not.toContainText("Connected");
    await capture(page, "offline-desktop");

    expect(await swaps(page)).toEqual([]);
    await expect(selectedTab(page)).toHaveAttribute("data-tab-id", tab ?? "");
  });

  test("on a phone, the open terminal says Reconnecting under its header, then offline in place", async ({ page }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    // Its own named shell on the machine, opened from the phone's list by that name: no state from an earlier spec (a
    // desktop page, a title hc gave a shell after a redial) decides which row it opens.
    await expect.poll(machineState, { timeout: REDIAL_BOUND_MS }).toBe("connected");
    remote = `${MACHINE_NAME}/${startShell("machine", "stays")}`;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await agentRow(page, "stays", true).click();
    const terminal = page.locator(`[data-terminal="${remote}"]`);
    await expect(terminal).toBeVisible({ timeout: 15_000 });

    switchTo("drop");
    const status = page.getByRole("status").filter({ hasText: `Reconnecting to ${MACHINE_NAME}` });
    await expect(status.first()).toBeVisible({ timeout: STATE_BOUND_MS });
    await expect(terminal).toBeVisible();
    await capture(page, "reconnecting-phone");
    const overlaps = await Promise.all((await status.all()).map((shown) => overlap(shown, terminal)));
    expect(overlaps).not.toContain(true);
    // Past the 5 s grace the line under the header says why, beside one Try again, still not over the terminal.
    const down = page.locator("[data-machine-down]");
    await expect(down).toContainText(MACHINE_NAME, { timeout: ACTION_GRACE_MS + STATE_BOUND_MS });
    await expect(down.getByRole("button", { name: "Try again" })).toHaveCount(1);
    // The reason is announced as it replaces the reconnect line: it is a live region of its own (#2617).
    await expect(down.getByRole("status")).toContainText(MACHINE_NAME);
    expect(await overlap(down, terminal)).toBe(false);
    // The reason says it keeps trying, so it takes the reconnect line's place: one line, and the terminal keeps its rows.
    await expect(status).toHaveCount(0);
    await capture(page, "machine-down-phone");
    await expect(page.getByText(`${MACHINE_NAME} is offline`)).toBeVisible({ timeout: OFFLINE_BOUND_MS });
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(1);
    await expect(status).toHaveCount(0);
    await capture(page, "offline-phone");
  });

  test("an unfocused split pane says its machine reconnects in its own header, not over its output", async ({
    page,
  }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 1440, height: 900 });
    remote = await remoteInView(page);
    await page.getByRole("button", { name: "Split right" }).first().click();
    const other = page.locator('[data-split="true"][data-focused="true"] [data-terminal]');
    await expect(other).not.toHaveAttribute("data-terminal", remote, { timeout: 15_000 });
    split = (await other.getAttribute("data-terminal")) ?? "";
    const unfocused = page.locator('section[data-split="true"][data-focused="false"]');
    await expect(unfocused.locator(`[data-terminal="${remote}"]`)).toBeVisible();

    switchTo("drop");
    const said = unfocused.locator("header").getByRole("status").filter({ hasText: "Reconnecting" });
    await expect(said).toBeVisible({ timeout: STATE_BOUND_MS });
    expect(await overlap(said, unfocused.locator(`[data-terminal="${remote}"]`))).toBe(false);
    await capture(page, "split-reconnecting-desktop");
    // Past the grace the pane says the machine is offline, and its header no longer says it reconnects (#2505 review).
    await expect(unfocused.getByText(`${MACHINE_NAME} is offline`)).toBeVisible({ timeout: OFFLINE_BOUND_MS });
    await expect(said).toHaveCount(0);
    reconnect();
  });
});

test.describe("the host link in view stays down past its grace (#2464 review)", () => {
  test("it says why as text beside one Try again, and the workspace stays", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 1440, height: 900 });
    const socket = await routeHcSocket(page);
    await page.goto("/");
    const terminal = await openNewTerminal(page);
    await socket.drop(true);
    const bar = page.getByRole("contentinfo");
    const help = bar.locator("[data-host-down]");
    await expect(help).toContainText("Your host", { timeout: 15_000 });
    expect(await shownWhole(help)).toBe(true);
    await expect(bar.getByRole("button", { name: "Try again" })).toHaveCount(1);
    await expect(bar.getByRole("status").filter({ hasText: "Reconnecting" })).toBeVisible();
    await expect(terminal).toBeVisible();
    await capture(page, "host-down-desktop");

    await page.setViewportSize({ width: 390, height: 844 });
    const line = page.locator("[data-host-down]").filter({ visible: true });
    await expect(line).toContainText("Your host");
    await expect(line.getByRole("button", { name: "Try again" })).toHaveCount(1);
    await capture(page, "host-down-phone");

    socket.restore();
    await expect(page.locator("[data-host-down]")).toHaveCount(0, { timeout: 15_000 });
  });
});
