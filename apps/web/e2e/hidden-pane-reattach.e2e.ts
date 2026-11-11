import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { E2E_HOST_ENV } from "./config.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { readSavedEnv } from "./saved-env.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

/** Which terminals terminal-view's hook saw attach, in order; null means the page never saw the hook. */
const attachLog = (page: Page): Promise<string[] | null> =>
  page.evaluate(() => {
    const log: unknown = Reflect.get(window, "__dorifaceAttachLog");
    return Array.isArray(log) ? log.map(String) : null;
  });

/** The host's answer to the last `method` request the page sent for `terminal`, once delivered; else undefined. */
function answerTo(socket: HcSocket, method: string, terminal: string): string | undefined {
  const request = socket
    .sent()
    .findLast((text) => text.includes(`"method":"${method}"`) && text.includes(`"terminal":"${terminal}"`));
  const id = /"id":(\d+)/.exec(request ?? "")?.[1];
  if (id === undefined) return undefined;
  return socket.received().find((text) => new RegExp(`"id":${id}[,}]`).test(text) && text.includes('"result"'));
}

/**
 * The host's answer to the last attach that opened `terminal`, found by the terminal it names: a new terminal's first
 * attach asks for it by the name its run gave it, before its address is known (#1351).
 */
function attachAnswer(socket: HcSocket, terminal: string): string | undefined {
  return socket
    .received()
    .findLast(
      (text) => text.includes('"result"') && text.includes('"channel":') && text.includes(`"address":"${terminal}"`),
    );
}

/** A core CLOSE with no exit facts on a stream channel: the core ended the stream while the program still runs. */
function coreClose(channel: number): Buffer {
  const frame = Buffer.alloc(9);
  frame.writeUInt32LE(channel, 0);
  frame.writeUInt8(2, 4);
  return frame;
}

/** Two terminals in two tabs, the first out of view without being unmounted: the pane this spec is about. */
async function twoTabs(page: Page): Promise<{ socket: HcSocket; hidden: string; shown: string }> {
  await page.addInitScript(() => {
    Reflect.set(window, "__dorifaceAttachLog", []);
  });
  const socket = await routeHcSocket(page);
  await page.goto("/");
  const hidden = (await (await openNewTerminal(page)).getAttribute("data-terminal")) ?? "";
  const shown = (await (await openNewTerminal(page)).getAttribute("data-terminal")) ?? "";
  await expect.poll(() => attachLog(page)).toEqual([hidden, shown]);
  return { socket, hidden, shown };
}

/** Stops every frame from the host, as when Wi-Fi goes away under an open socket, until the link comes back. */
async function dropAndReconnect(page: Page, socket: HcSocket): Promise<void> {
  const opened = socket.opened();
  const release = socket.holdFromHost("");
  const reconnecting = page.getByRole("status").filter({ hasText: /Reconnecting/ });
  await expect(reconnecting).toBeVisible({ timeout: 60_000 });
  release();
  await expect.poll(socket.opened, { timeout: 20_000 }).toBeGreaterThan(opened);
  await expect(reconnecting).toHaveCount(0, { timeout: 20_000 });
}

test("a pane out of view waits to re-attach until it is shown, so a drop replays a hidden tab once, when someone looks (#639)", async ({
  page,
}) => {
  // Three missed core heartbeats (15 s apart) are the budget the drop waits out; the wait is the behaviour under test.
  test.setTimeout(150_000);
  const { socket, hidden, shown } = await twoTabs(page);
  await dropAndReconnect(page, socket);

  // The pane on screen re-attaches; the hidden one has nobody to show a replay to, so it is not in the log.
  await expect.poll(() => attachLog(page)).toEqual([hidden, shown, shown]);

  // Showing it is what pays for its replay, once.
  await page.getByRole("tab").first().click();
  await expect.poll(() => attachLog(page)).toEqual([hidden, shown, shown, hidden]);
});

test("a pane out of view whose stream the core ends waits to re-attach until it is shown (#906)", async ({ page }) => {
  const { socket, hidden, shown } = await twoTabs(page);
  const channel = /"channel":(\d+)/.exec(attachAnswer(socket, hidden) ?? "")?.[1];
  if (channel === undefined) throw new Error("the host's answer to the hidden pane's attach names no channel");
  socket.sendFromHost(coreClose(Number(channel)));

  // The view asks the core what is left of its program; it still runs, so the view is to attach to it again.
  await expect.poll(() => answerTo(socket, "terminal.get", hidden)).toBeDefined();
  // Read after the page has handled that answer: the pane is out of view, so nothing attached.
  expect(await attachLog(page)).toEqual([hidden, shown]);

  await page.getByRole("tab").first().click();
  await expect.poll(() => attachLog(page)).toEqual([hidden, shown, hidden]);
});

test("a pane that mounts out of view, as a background tab after a reload, does not attach until it is shown (#1187)", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { hidden, shown } = await twoTabs(page);
  await page.reload();
  const tabs = page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
  await expect(tabs).toHaveCount(2);
  // The tab on screen is the one selected before the reload; the other mounts hidden.
  const onScreen = page.locator(`[data-terminal="${shown}"]`);
  await expect(onScreen).toBeVisible();
  await expect(onScreen).toHaveAttribute("data-ready", "true");
  await expect.poll(() => attachLog(page)).toEqual([shown]);
  // The hidden pane is mounted and its renderer ready, yet it has opened no stream.
  await expect(page.locator(`[data-terminal="${hidden}"]`)).toHaveAttribute("data-ready", "true");
  expect(await attachLog(page)).toEqual([shown]);

  await tabs.first().click();
  await expect.poll(() => attachLog(page)).toEqual([shown, hidden]);
});

test("a program that ends while its pane is out of view and holds no stream is found when the pane is shown (#906)", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { socket, hidden, shown } = await twoTabs(page);
  await dropAndReconnect(page, socket);
  await expect.poll(() => attachLog(page)).toEqual([hidden, shown, shown]);

  const { hc, env } = readSavedEnv(E2E_HOST_ENV);
  execFileSync(hc, ["kill", hidden], { env: { ...process.env, ...env } });
  const tabs = page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
  // Nothing tells the hidden pane: it holds no stream, and the core's CLOSE went to no one.
  await expect(tabs).toHaveCount(2);

  // Shown, it attaches, the core says the program is over, and its tab closes as that CLOSE would have closed it.
  await tabs.first().click();
  await expect(tabs).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator(`[data-terminal="${shown}"]`)).toBeVisible();
  expect(await attachLog(page)).toEqual([hidden, shown, shown, hidden]);
});
