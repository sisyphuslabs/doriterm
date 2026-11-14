// #2531: the machine order is one arrangement per person. Two devices that reach the same two machines through
// different hosts show them in the same order, an order arranged on one is the order on the other, and a device whose
// route moves to the other host keeps the order it had. The second host is the e2e host's added machine, given its own
// doriface-host gateway here and the e2e host's core as an added machine of its own, so each core lists the other.
import type { Browser, Page } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { E2E_HOST_ENV, E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { machineCore, setCoreDoc } from "./core-doc.ts";
import { expect, test } from "./fixtures.ts";
import { MACHINE_ENV, MACHINE_NAME } from "./machine.ts";
import { hcOn } from "./machine-switch.ts";
import { readSavedEnv } from "./saved-env.ts";

test.use({ serviceWorkers: "block" });

const ORDER_DOC = "doriface";
/** The e2e host's core: its hello names it so, and the second core adds it under that name. */
const FIRST = "studio";
/** The second core names itself `build`, and the e2e host lists it as MACHINE_NAME: one machine either way. */
const SECOND_OWN = "build";
const machineOf = (name: string | null | undefined): string =>
  name === FIRST ? "first" : name === MACHINE_NAME || name === SECOND_OWN ? "second" : `unknown:${String(name)}`;

const FIRST_URL = `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`;
let secondUrl = "";
let gateway: ChildProcess | undefined;

const rows = (page: Page) => page.locator("[data-machine-row]");
const order = async (page: Page): Promise<readonly string[]> =>
  (await rows(page).evaluateAll((els) => els.map((el) => el.querySelector("span[title]")?.getAttribute("title")))).map(
    machineOf,
  );

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });
}

function clearOrders(): void {
  setCoreDoc(ORDER_DOC, null);
  setCoreDoc(ORDER_DOC, null, undefined, "machine");
}

test.beforeAll(async () => {
  const first = readSavedEnv(E2E_HOST_ENV);
  const second = readSavedEnv(MACHINE_ENV);
  const session = second.env["HC_SESSION"];
  if (session === undefined) throw new Error(`${MACHINE_ENV} names no HC_SESSION`);
  const env = Object.entries(first.env)
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ");
  // A worker that restarts after a failed test runs this again: the machine an earlier run added goes first.
  if (hcOn("machine", ["machine", "ls"]).includes(FIRST)) hcOn("machine", ["machine", "rm", FIRST]);
  hcOn("machine", ["machine", "add", "--via", `sh -c 'exec env ${env} sh -c "$1"' sh`, "--name", FIRST]);
  const port = await freePort();
  gateway = spawn(
    "bun",
    [
      join(import.meta.dirname, "../../host/src/cli.ts"),
      "--listen",
      `127.0.0.1:${port}`,
      "--hc",
      second.hc,
      "--session",
      session,
      "--token",
      E2E_TOKEN,
      "--no-relay",
    ],
    { env: { ...process.env, ...second.env }, stdio: "inherit" },
  );
  secondUrl = `ws://127.0.0.1:${port}/v1/hc`;
  await expect
    .poll(
      () =>
        fetch(`http://127.0.0.1:${port}/healthz`).then(
          (answer) => answer.status,
          () => 0,
        ),
      { timeout: 30_000 },
    )
    .toBe(200);
});

test.afterAll(async () => {
  const running = gateway;
  if (running !== undefined && running.exitCode === null) {
    const exited = new Promise((resolve) => running.once("exit", resolve));
    running.kill("SIGTERM");
    await exited;
  }
  hcOn("machine", ["machine", "rm", FIRST]);
  clearOrders();
});

test.beforeEach(clearOrders);

/** Opens the workspace with the page's saved connection on the gateway at `url`: a cold start through that host. */
async function routeThrough(page: Page, url: string): Promise<Page> {
  const settings = {
    mode: "loopback",
    relayUrl: "wss://relay-doriface.omo.dev",
    directUrl: "",
    hostId: "",
    token: E2E_TOKEN,
  };
  await page.addInitScript(
    (value) => localStorage.setItem("doriface.connection", value),
    JSON.stringify({ ...settings, loopbackUrl: url }),
  );
  await page.goto("/");
  await expect(rows(page)).toHaveCount(2, { timeout: 30_000 });
  return page;
}

/** A device of its own (its own storage), routed through the gateway at `url`. */
async function device(browser: Browser, url: string): Promise<Page> {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1100, height: 760 } });
  return routeThrough(await context.newPage(), url);
}

async function moveFirstRowDown(page: Page): Promise<void> {
  await rows(page).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move down" }).click();
}

test("before anyone arranges them, two devices routed through different hosts list the machines in one order", async ({
  browser,
}) => {
  const [one, two] = await Promise.all([device(browser, FIRST_URL), device(browser, secondUrl)]);
  await expect.poll(async () => order(one)).toEqual(await order(two));
});

test("an order arranged on one device is the order on the other device, which routes through the other host", async ({
  browser,
}) => {
  const [one, two] = await Promise.all([device(browser, FIRST_URL), device(browser, secondUrl)]);
  const before = await order(one);
  await moveFirstRowDown(one);
  const arranged = before.toReversed();
  await expect.poll(async () => order(one)).toEqual(arranged);
  await expect.poll(async () => order(two), { timeout: 15_000 }).toEqual(arranged);
  // And back from the second device: the first follows it.
  await moveFirstRowDown(two);
  await expect.poll(async () => order(two)).toEqual(before);
  await expect.poll(async () => order(one), { timeout: 15_000 }).toEqual(before);
});

test("a device whose route moves to the other host keeps the order, and no machine jumps to the top", async ({
  browser,
}) => {
  const one = await device(browser, FIRST_URL);
  const before = await order(one);
  const rerouted = await routeThrough(await one.context().newPage(), secondUrl);
  await expect.poll(async () => order(rerouted)).toEqual(before);
  // Arranged on the new route, then back on the first one: still the one order.
  await moveFirstRowDown(rerouted);
  const arranged = before.toReversed();
  await expect.poll(async () => order(rerouted)).toEqual(arranged);
  const back = await routeThrough(await one.context().newPage(), FIRST_URL);
  await expect.poll(async () => order(back)).toEqual(arranged);
});

test("orders each host kept before the shared one become one order, the opening device's host's", async ({
  browser,
}) => {
  const firstId = machineCore(FIRST, "machine");
  const secondId = machineCore(MACHINE_NAME);
  setCoreDoc(ORDER_DOC, { machine_order: [secondId, firstId] });
  setCoreDoc(ORDER_DOC, { machine_order: [firstId, secondId] }, undefined, "machine");
  const one = await device(browser, FIRST_URL);
  await expect.poll(async () => order(one)).toEqual(["second", "first"]);
  const two = await device(browser, secondUrl);
  await expect.poll(async () => order(two), { timeout: 15_000 }).toEqual(["second", "first"]);
});

test("Settings names no host as the one this device is attached to", async ({ browser }) => {
  const two = await device(browser, secondUrl);
  await two.goto("/settings");
  await expect(two.getByRole("heading", { name: "Settings" }).first()).toBeVisible({ timeout: 30_000 });
  await expect(two.getByText(/Connected through/)).toHaveCount(0);
  await expect(two.getByText("Switch to this machine")).toHaveCount(0);
});
