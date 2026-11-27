// What a machine's layout keeps through its reconnect and the machine.list reads after it: the dead-pane check drops only
// a terminal the machine says is gone, never an empty space or a live terminal its feed has not listed yet (#2957).
import type { Page } from "@playwright/test";
import { startShell } from "./agents.ts";
import { getCoreDoc } from "./core-doc.ts";
import { expect, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { LAYOUT_DOC, seedSpaces } from "./layout-doc.ts";
import { MACHINE_NAME } from "./machine.ts";
import {
  machineState,
  OFFLINE_BOUND_MS,
  OFFLINE_TEST_TIMEOUT_MS,
  reconnect,
  STATE_BOUND_MS,
  switchTo,
} from "./machine-switch.ts";

/**
 * Counts the machine.list requests the page sends, so a check can wait until the page has read the list again: a pane
 * an added machine no longer runs is dropped only after two reads (useDeadPanes), so what survives a third is kept.
 * Call before page.goto.
 */
async function listReads(page: Page): Promise<(more: number) => Promise<void>> {
  let sent = 0;
  const waiting: { readonly at: number; readonly done: () => void }[] = [];
  await routeHcSocket(page, {
    sent: (frame) => {
      if (!frame.includes('"method":"machine.list"')) return;
      sent += 1;
      for (const waiter of waiting.filter((one) => one.at <= sent)) {
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.done();
      }
    },
  });
  return (more) => {
    const done = Promise.withResolvers<void>();
    waiting.push({ at: sent + more, done: () => done.resolve() });
    return done.promise;
  };
}

test("on a phone, an offline machine's empty space offers New tab here and Close space disabled with why", async ({
  page,
}) => {
  test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
  await page.setViewportSize({ width: 390, height: 844 });
  const reads = await listReads(page);
  const name = "nothing-running";
  // A space with no tab: its screen shows the empty state. A tab on a terminal that never existed would be dropped as
  // dead at the page's second machine.list read after the reconnect, and its space with it (#2957).
  seedSpaces([{ id: `spc-${name}`, name, folder: "/tmp", tabs: [] }], MACHINE_NAME);
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
  // Past every read that could drop a pane: the space and its actions stay.
  await reads(3);
  await expect(newHere).toBeEnabled();
  await expect(closeSpace).toBeEnabled();
});

// The dead-pane check drops only a terminal the machine says is gone: a live one its feed has not listed yet after a
// reconnect is kept, however soon the reads after it come (#2957).
test("a tab on a live terminal of a machine keeps its place through the machine's reconnect and the reads after it", async ({
  page,
}) => {
  test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
  await page.setViewportSize({ width: 390, height: 844 });
  const reads = await listReads(page);
  const name = "still-running";
  const terminal = startShell("machine", name);
  seedSpaces([{ id: `spc-${name}`, name, folder: "/tmp", tabs: [{ id: `tb-${name}`, name, terminal }] }], MACHINE_NAME);
  await page.goto("/?v=spaces");
  await page.getByText(name).first().click({ timeout: 20_000 });
  const running = page.getByText(`Nothing is running in ${name}`);
  await expect(page.getByText(name).last()).toBeVisible({ timeout: 20_000 });
  await expect(running).toHaveCount(0);
  try {
    switchTo("drop");
    await expect.poll(machineState, { timeout: STATE_BOUND_MS }).not.toBe("connected");
  } finally {
    reconnect();
  }
  await expect.poll(machineState, { timeout: STATE_BOUND_MS }).toBe("connected");
  // Past every read that could drop a pane: the live terminal's tab is still the space's.
  await reads(3);
  await expect(page.getByText(name).last()).toBeVisible();
  await expect(running).toHaveCount(0);
  expect(getCoreDoc(LAYOUT_DOC, MACHINE_NAME)).toMatchObject({
    spaces: [{ id: `spc-${name}`, tabs: [{ id: `tb-${name}` }] }],
  });
});
