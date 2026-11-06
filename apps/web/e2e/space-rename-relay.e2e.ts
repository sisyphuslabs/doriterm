import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { pressNewTab } from "./fixtures.ts";
import { routeRelaySockets } from "./relay-route.ts";
import { PRIVATE_RELAY_SKIP } from "./private-relay.ts";

// Two devices paired with one host through the private relay: a space renamed on one shows on the other at once (#395).
// The relay-host helper runs a real host and hc under wrangler dev, so this needs a relay checkout (DORIFACE_RELAY_DIR,
// as `bun run relay:fetch` makes) and is skipped without one.
test.skip(process.env["DORIFACE_RELAY_DIR"] === undefined, PRIVATE_RELAY_SKIP);
test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const HELPER = join(import.meta.dirname, "..", "..", "..", "tests", "relay", "support", "web-relay-host.ts");
let helper: ChildProcess | undefined;
let reader: AsyncIterator<string> | undefined;
let relayUrl = "";

/** The next line the helper prints that starts with `prefix`, without the prefix; other lines are skipped. */
async function nextLine(prefix: string): Promise<string> {
  const next = await reader?.next();
  if (next === undefined || next.done === true) throw new Error(`relay-host ended before a ${prefix.trim()} line`);
  return next.value.startsWith(prefix) ? next.value.slice(prefix.length) : nextLine(prefix);
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  // Playwright sets FORCE_COLOR for its workers; wrangler would colour the line the helper waits for.
  const { FORCE_COLOR: _colour, ...inherited } = process.env;
  helper = spawn("bun", [HELPER], { stdio: ["pipe", "pipe", "inherit"], env: { ...inherited, NO_COLOR: "1" } });
  if (helper.stdout === null) throw new Error("relay-host has no stdout");
  reader = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
  ({ relayUrl } = JSON.parse(await nextLine("READY ")) as { relayUrl: string });
});

test.afterAll(async () => {
  const running = helper;
  if (running === undefined) return;
  running.kill("SIGTERM");
  await expect.poll(() => running.exitCode ?? running.signalCode, { timeout: 60_000 }).not.toBeNull();
});

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });
const spaceRows = (page: Page) =>
  sidebar(page).getByRole("region", { name: "Spaces on this machine" }).getByRole("button");
const spaceRow = (page: Page, name: string) =>
  sidebar(page).getByRole("button", { name: new RegExp(`^${name}(?: |$)`) });

/** A device of its own (its own storage and key), paired with the relayed host by its link, in the workspace. */
async function pairedDevice(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext({ serviceWorkers: "block" })).newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  // Pairing dials the link's relay; the workspace then dials the production one, as every release build does (#452).
  await routeRelaySockets(page, relayUrl);
  helper?.stdin?.write("PAIR\n");
  await page.goto(`/pair${await nextLine("LINK ")}`);
  await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
  await expect(page.getByText("This device now reaches the host through the relay")).toBeVisible({ timeout: 60_000 });
  await page
    .getByRole("link", { name: "Open terminals" })
    .or(page.getByRole("button", { name: "Open terminals" }))
    .click();
  return page;
}

test("over the relay, a space renamed on one device shows its new name on the other without a reload", async ({
  browser,
}) => {
  const renamed = `rn395-relay-${test.info().repeatEachIndex}`;
  const one = await pairedDevice(browser);
  const two = await pairedDevice(browser);
  await pressNewTab(one.getByRole("button", { name: "New tab", exact: true }), { timeout: 60_000 });
  const row = spaceRows(one).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  const before = (await row.locator('[data-floor="name"]').textContent()) ?? "";
  expect(before).not.toBe("");
  await expect(spaceRow(two, before)).toBeVisible({ timeout: 30_000 });

  await row.hover();
  await sidebar(one)
    .getByRole("button", { name: `More for ${before}` })
    .click();
  await one.getByRole("menuitem", { name: "Rename space…" }).click();
  const dialog = one.getByRole("dialog", { name: `Rename ${before}` });
  await dialog.getByRole("textbox", { name: "Name" }).fill(renamed);
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(dialog).toBeHidden();
  await Promise.all([one, two].map((device) => expect(spaceRow(device, renamed)).toBeVisible({ timeout: 30_000 })));
  await Promise.all([one, two].map((device) => expect(spaceRow(device, before)).toHaveCount(0)));
  await Promise.all([one.context().close(), two.context().close()]);
});
