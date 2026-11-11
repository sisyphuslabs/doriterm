import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { pressShortcut } from "./platform-keys.ts";
import { routeRelaySockets } from "./relay-route.ts";
import { PRIVATE_RELAY_SKIP } from "./private-relay.ts";

// #2309: a change made on one device reaches another device behind the real relay without an interaction (#1837,
// fixed by #1876). Two devices pair with host a through the private relay under wrangler dev; b is not in a's mesh yet
// (MESH_JOIN=skip), so it can join while both devices are open. The bound is 1.5 s, under the roster's 10 s machine.list
// read, so only a pushed change can meet it; every wait is on a state, never on a fixed time.
test.skip(process.env["DORIFACE_RELAY_DIR"] === undefined, PRIVATE_RELAY_SKIP);
test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const PUSHED_MS = 1_500;
const HELPER = join(import.meta.dirname, "..", "..", "..", "tests", "relay", "support", "web-mesh-hosts.ts");
let helper: ChildProcess | undefined;
let reader: AsyncIterator<string> | undefined;
let relayUrl = "";

async function nextLine(prefix: string): Promise<string> {
  const next = await reader?.next();
  if (next === undefined || next.done === true) throw new Error(`mesh-hosts ended before a ${prefix.trim()} line`);
  return next.value.startsWith(prefix) ? next.value.slice(prefix.length) : nextLine(prefix);
}

async function ask(line: string, prefix: string): Promise<string> {
  helper?.stdin?.write(`${line}\n`);
  return nextLine(prefix);
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  // Playwright sets FORCE_COLOR for its workers; wrangler would colour the line the helper waits for.
  const { FORCE_COLOR: _colour, ...inherited } = process.env;
  helper = spawn("bun", [HELPER], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...inherited, NO_COLOR: "1", MESH_JOIN: "skip" },
  });
  if (helper.stdout === null) throw new Error("mesh-hosts has no stdout");
  reader = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
  ({ relayUrl } = JSON.parse(await nextLine("READY ")) as { relayUrl: string });
});

test.afterAll(async () => {
  const running = helper;
  if (running === undefined) return;
  running.kill("SIGTERM");
  await expect.poll(() => running.exitCode ?? running.signalCode, { timeout: 90_000 }).not.toBeNull();
});

/** A device paired with a through the relay, on its workspace. */
async function device(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await routeRelaySockets(page, relayUrl);
  await page.goto(`/pair${await ask("PAIR", "LINK ")}`);
  await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
  await expect(page.getByText("This device now reaches the host through the relay")).toBeVisible({ timeout: 60_000 });
  await page
    .getByRole("link", { name: "Open terminals" })
    .or(page.getByRole("button", { name: "Open terminals" }))
    .click();
  await expect(spaces(page)).toBeVisible({ timeout: 60_000 });
  return page;
}

const spaces = (page: Page): Locator =>
  page.getByRole("complementary", { name: "Workspace" }).getByRole("region", { name: "Spaces", exact: true });

const rowNames = async (page: Page): Promise<readonly string[]> =>
  (await spaces(page).getByRole("button").allTextContents()).map((text) => text.trim());

test("a space opened on one device shows on another behind the relay within 1.5 s, with no interaction there", async ({
  browser,
}) => {
  const [writer, reader2] = [await device(browser), await device(browser)];
  const before = await rowNames(writer);
  await pressShortcut(writer, "space.new");
  await expect.poll(async () => (await rowNames(writer)).length, { timeout: 30_000 }).toBeGreaterThan(before.length);
  const opened = (await rowNames(writer)).find((name) => !before.includes(name));
  if (opened === undefined) throw new Error("the writer shows no new space row");
  await expect(spaces(reader2).getByRole("button").filter({ hasText: opened })).toBeVisible({ timeout: PUSHED_MS });
  await writer.context().close();
  await reader2.context().close();
});

test("a machine that joins the mesh while two devices are open shows on the untouched one within 1.5 s", async ({
  browser,
}) => {
  const watcher = await device(browser);
  const machine = await ask("JOIN", "JOINED ");
  await expect(spaces(watcher).getByRole("region", { name: machine, exact: true })).toBeVisible({ timeout: PUSHED_MS });
  await watcher.context().close();
});
