// A workspace opened on one device, or a machine added to the core, shows on another device with no action there: the
// roster rides hc's `doc` events and its `missed` (which hc sends when a line comes up) instead of a timer or a click.
import type { Browser, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { E2E_HOST_ENV, E2E_HOST_PORT, E2E_MACHINE_DIR, E2E_TOKEN } from "./config.ts";
import { expect, test } from "./fixtures.ts";
import { viaCommand } from "./machine.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { readSavedEnv } from "./saved-env.ts";
import { rows } from "./sidebar-measure.ts";

endOwnTerminals();

test.use({ serviceWorkers: "block" });

/** Well under the 10 s machine.list fallback: a change that shows within this came through the feed, not the timer. */
const THROUGH_THE_FEED_MS = 5_000;

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });
/** The space rows of this core's own group in Spaces: one per space its layout holds, apart from the group's header and its empty-state row. */
const ownSpaceRows = (page: Page) =>
  rows(
    sidebar(page).getByRole("region", { name: "Spaces" }).getByRole("region", { name: "studio", exact: true }),
  ).filter({
    hasNotText: /connected|New space there/,
  });
const machineRow = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}\\b`) });

/**
 * A second device: its own browser context (its own storage) on the same host, like space-rename.e2e.ts, in a narrower
 * window so the two captures are told apart at a glance.
 */
async function secondDevice(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1100, height: 720 } });
  const settings = {
    mode: "loopback",
    relayUrl: "wss://relay-doriface.omo.dev",
    directUrl: "",
    hostId: "",
    loopbackUrl: `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`,
    token: E2E_TOKEN,
  };
  await context.addInitScript((value) => localStorage.setItem("doriface.connection", value), JSON.stringify(settings));
  return context.newPage();
}

async function capture(page: Page, name: string): Promise<void> {
  const dir = test.info().outputPath("roster-sync");
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

test("a space opened on one device is listed on the other at once, with nothing done there", async ({
  page,
  browser,
}) => {
  const other = await secondDevice(browser);
  await Promise.all([page.goto("/"), other.goto("/")]);
  await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(other.getByRole("region", { name: "Spaces" }).getByRole("region").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(ownSpaceRows(other)).toHaveCount(0);
  await capture(other, "space-device-b-before");

  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "New space" }).click();
  await expect(page.getByRole("tablist", { name: "Tabs" }).getByRole("tab")).toHaveCount(1, { timeout: 15_000 });

  await expect(ownSpaceRows(other)).toHaveCount(1, { timeout: THROUGH_THE_FEED_MS });
  await expect(ownSpaceRows(other).first()).toContainText("1");
  await capture(page, "space-device-a-after");
  await capture(other, "space-device-b-after");
});

test("a machine added to the core is listed on another device at once, before any timer could", async ({
  page,
  browser,
}) => {
  const name = `fleet-${test.info().repeatEachIndex}`;
  const { hc, env } = readSavedEnv(E2E_HOST_ENV);
  const root = join(E2E_MACHINE_DIR, "..", `doriface-web-e2e-${E2E_HOST_PORT}-${name}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "switch-dir"), { recursive: true });
  const own = {
    HC_SESSION: `web-e2e-${name}-${crypto.randomUUID().slice(0, 8)}`,
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "run"),
    HC_SOCKET: join(root, "c.sock"),
    PATH: `${dirname(hc)}:${env["PATH"] ?? "/usr/bin:/bin"}`,
  };
  const stopCore = (): void => {
    const call = '{"jsonrpc":"2.0","id":1,"method":"server.stop"}\n';
    execFileSync(hc, ["connect", "--session", own.HC_SESSION], {
      env: { ...process.env, ...env, ...own },
      input: call,
    });
  };
  const other = await secondDevice(browser);
  try {
    await Promise.all([page.goto("/"), other.goto("/")]);
    await expect(page.getByRole("region", { name: "Spaces" })).toBeVisible({ timeout: 20_000 });
    await expect(other.getByRole("region", { name: "Spaces" })).toBeVisible({ timeout: 20_000 });
    await expect(machineRow(other, name)).toHaveCount(0);
    await capture(other, "machine-device-b-before");

    const spec = { name, dir: join(root, "switch-dir"), seeds: [] };
    hcOn("host", ["machine", "add", "--via", viaCommand(own, spec), "--name", name]);

    await expect(machineRow(other, name)).toBeVisible({ timeout: THROUGH_THE_FEED_MS });
    await expect(machineRow(page, name)).toBeVisible({ timeout: THROUGH_THE_FEED_MS });
    await capture(page, "machine-device-a-after");
    await capture(other, "machine-device-b-after");
  } finally {
    hcOn("host", ["machine", "rm", name]);
    stopCore();
    rmSync(root, { recursive: true, force: true });
  }
});
