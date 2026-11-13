// #2464: the machine of the terminal in view drops. The view stays on that terminal's tab: it says it is reconnecting
// beside the terminal, never over its output, and comes back by itself; a machine that stays gone reads offline in the
// same place with one way on. A drop never moves the person to another tab.
import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
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

/** The page as it is now at the desktop window and at a 390 px phone, for the pull request's before and after. */
async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}-desktop.png`) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath(`${name}-phone.png`) });
  await page.setViewportSize({ width: 1280, height: 720 });
}

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
  test.afterEach(() => {
    reconnect();
    if (remote !== "") hcOn("machine", ["kill", remote.slice(MACHINE_NAME.length + 1)]);
    remote = "";
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
    for (const shown of await status.all()) expect(await overlap(shown, terminal)).toBe(false);
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
    await capture(page, "reconnecting");
    const pane = page.locator('[data-focused="true"]');
    await expect(pane.getByText(`${MACHINE_NAME} is offline`)).toBeVisible({ timeout: OFFLINE_BOUND_MS });
    await expect(pane.getByRole("button")).toHaveCount(1);
    await expect(pane.getByRole("button", { name: "Try again" })).toBeVisible();
    await capture(page, "offline");

    expect(await swaps(page)).toEqual([]);
    await expect(selectedTab(page)).toHaveAttribute("data-tab-id", tab ?? "");
  });
});
