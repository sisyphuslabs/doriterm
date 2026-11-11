// #904: a mesh line that drops and comes back within the grace never reads offline, nor do the tabs on its machine; a
// machine that is really gone reads offline once the grace ends, never before.
import type { Page } from "@playwright/test";
import { OFFLINE_GRACE_MS } from "../src/workspace/machine-grace.ts";
import { agentRow, endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import {
  blip,
  machineRow,
  machineState,
  linesDialed,
  OFFLINE_BOUND_MS,
  reconnect,
  redialedSince,
  slowDials,
  switchOn,
  switchTo,
  OFFLINE_TEST_TIMEOUT_MS,
} from "./machine-switch.ts";

/**
 * The longest a host refuses a member's line after a relay blip: its settle (DIAL_LIMITS.settleMaxMs, 20 s), then the
 * first probe of a member whose dial met a 4404 while it was reconnecting too (DIAL_LIMITS.probeFirstMs, 30 s). hc's
 * own redial then lands the line about 62 s after the drop, as measured on a real blip (#904).
 */
const HOST_WORST_REFUSAL_MS = 20_000 + 30_000;

/**
 * Records, from now on, every moment the page shows the machine or its tab as anything but up: the machine's row in any
 * state but connected or reconnecting, an Offline agents group, or the tab's terminal view gone. A MutationObserver sees each change as
 * it renders, so a flip shorter than any poll is recorded too.
 */
async function recordFlips(page: Page, terminal: string): Promise<void> {
  await page.evaluate(
    ([name, address]) => {
      const flips: string[] = [];
      const check = (): void => {
        const row = document.querySelector(`[data-machine-header="${name}"]`)?.getAttribute("title") ?? "no row";
        if (row !== `${name}, connected` && row !== `${name}, reconnecting`) flips.push(`row: ${row}`);
        for (const group of document.querySelectorAll("section[aria-labelledby]")) {
          const title = document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent ?? "";
          if (title.trim().startsWith("Offline")) flips.push(`group: ${title.trim()}`);
        }
        if (document.querySelector(`[data-terminal="${address}"]`) === null) flips.push("tab: terminal view gone");
      };
      check();
      new MutationObserver(check).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      Object.assign(window, { flips });
    },
    [MACHINE_NAME, terminal] as const,
  );
}

const flips = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...new Set((window as unknown as { flips: string[] }).flips)]);

test.describe("a machine whose line blips (#904)", () => {
  let address = "";
  test.beforeEach(() => {
    address = startAgent("machine", "crunch", "working");
  });
  test.afterEach(() => {
    reconnect();
    endAgent("machine", address);
  });

  test("a relay uplink drop with the host's settle and an hc redial flip neither the machine nor its tab", async ({
    page,
  }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    await page.goto("/");
    await expect(machineRow(page)).toContainText(/connected\s*1/, { timeout: 20_000 });
    await agentRow(page, "crunch", true).click();
    const terminal = `${MACHINE_NAME}/${address}`;
    await expect(page.locator(`[data-terminal="${terminal}"]`)).toBeVisible({ timeout: 15_000 });
    await recordFlips(page, terminal);

    // A line that hc redials at once: the drop alone, over a dial as slow as a loaded runner's. The next blip must find
    // hc's redial landed and no dial still on its way: one still dialing then gets past the refusal and lands anyway.
    // hc's state is no sign of it: it reads connected all through a drop it redials (#1518).
    slowDials();
    const dialed = linesDialed();
    await blip(0);
    await expect.poll(() => redialedSince(dialed), { timeout: 30_000 }).toBe(true);
    // redialedSince is a moment's reading, and the switch stays slow until the next blip writes it: put it back to fast
    // now, so a dial hc starts after the poll passed cannot sleep and land past the refusal below (#2065).
    switchOn();
    await expect.poll(machineState, { timeout: 15_000 }).toBe("connected");

    // A relay uplink drop at its worst: every line ends, and the host refuses this one for its settle and one probe.
    // hc reads the machine unreachable through it (several of the page's machine.list reads), then its redial lands the
    // line.
    const settled = blip(HOST_WORST_REFUSAL_MS);
    await expect.poll(machineState, { timeout: 5_000 }).toBe("unreachable");
    await settled;
    await expect.poll(machineState, { timeout: OFFLINE_GRACE_MS }).toBe("connected");
    expect(await flips(page)).toEqual([]);
    await expect(agentRow(page.getByRole("region", { name: "Working" }), "crunch", true)).toBeVisible();
  });

  test("a machine that is really gone reads offline in the status bar, its view kept, once the grace ends and not before", async ({
    page,
  }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    await page.goto("/");
    await expect(machineRow(page)).toContainText(/connected\s*1/, { timeout: 20_000 });
    await agentRow(page, "crunch", true).click();
    const terminal = `${MACHINE_NAME}/${address}`;
    await expect(page.locator(`[data-terminal="${terminal}"]`)).toBeVisible({ timeout: 15_000 });
    switchTo("drop");
    const dropped = Date.now();
    await expect.poll(machineState, { timeout: 5_000 }).toBe("unreachable");
    await expect(machineRow(page)).toContainText("offline", { timeout: OFFLINE_BOUND_MS });
    // The page counts the grace from hc's own drop time, moved back at most one 10 s read, so it never ends early.
    expect(Date.now() - dropped).toBeGreaterThanOrEqual(OFFLINE_GRACE_MS - 10_000);
    // The view stays where it was and the status bar says why (#2003); nothing replaces or covers the terminal.
    await expect(page.locator(`[data-terminal="${terminal}"]`)).toHaveCount(1);
    await expect(
      page
        .getByRole("contentinfo")
        .getByRole("status")
        .filter({ hasText: `${MACHINE_NAME} is offline` }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Offline" })).toBeVisible();
  });
});
