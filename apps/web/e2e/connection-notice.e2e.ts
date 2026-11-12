import { devices, type Locator, type Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { type FakeRelayHost, startFakeRelayHost } from "./relay-route.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];

/** What the screen says about the connection, wherever it says it. */
const notice = (page: Page, text: RegExp) => page.getByRole("status").filter({ hasText: text });

const OFFLINE = /Offline/;
const NEXT_STEP = "Reconnects when the network is back";
const onlineDot = (page: Page) => page.locator('[data-machine-dot="online"]');

const RECONNECTING = /Reconnecting/;

/**
 * The phone line's glyph (spinner or offline icon) sits on the sentence's first line, centred on it as the text is (#1961):
 * a box as tall as a line, not a 16 px box at the top of a 20 px line. The bound is 1 px: the centres measure 0.5 px apart
 * (half-pixel rounding), and a spinning glyph's box drifts by a few millionths, so a 0.5 px bound fails by chance. The old
 * mt-0.5 nudge this guards against moved the glyph 2 px.
 */
async function glyphCentredOnFirstLine(line: Locator): Promise<void> {
  const centres = await line.evaluate((status) => {
    const glyph = status.querySelector("svg")?.getBoundingClientRect();
    const words = status.querySelector("span[title]");
    const range = document.createRange();
    if (words?.firstChild) range.selectNodeContents(words.firstChild);
    const first = range.getClientRects()[0];
    return glyph === undefined || first === undefined
      ? null
      : { glyph: glyph.top + glyph.height / 2, text: first.top + first.height / 2 };
  });
  expect(centres).not.toBeNull();
  expect(Math.abs((centres?.glyph ?? 0) - (centres?.text ?? 0))).toBeLessThanOrEqual(1);
}

/** What the OS says about the network, as the page sees it; a link to 127.0.0.1 keeps its own state either way. */
const osOnline = (page: Page, online: boolean) =>
  page.evaluate((value) => {
    Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: () => value });
    dispatchEvent(new Event(value ? "online" : "offline"));
  }, online);

/**
 * Pairs the page with a host across the network over the relay (#462: the loopback link only ever reaches this
 * computer), and keeps those settings across loads: the fixture seeds loopback settings on every load.
 */
async function pairAcrossTheNetwork(page: Page, host: FakeRelayHost): Promise<void> {
  await host.route(page);
  await page.goto(await host.pairingLink());
  await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
  await expect(page.getByRole("status").getByText("Paired")).toBeVisible({ timeout: 30_000 });
  const paired = await page.evaluate(() => localStorage.getItem("doriface.connection"));
  if (paired === null) throw new Error("pairing saved no connection");
  await page.addInitScript((value) => localStorage.setItem("doriface.connection", value), paired);
}

async function echoes(page: Page, marker: string): Promise<void> {
  const terminal = page.locator("[data-terminal]").filter({ visible: true }).first();
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`echo ${marker}-$((2+3))`);
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(`${marker}-5`, { timeout: 20_000 });
}

test.describe("desktop", () => {
  test.describe("a host across the network", () => {
    let host: FakeRelayHost;
    test.beforeAll(async () => {
      test.setTimeout(60_000);
      host = await startFakeRelayHost({ machine: true });
    });
    test.afterAll(async () => host.stop());

    test("going offline is said in the status bar at once, and the notice leaves when the network is back", async ({
      page,
      context,
    }) => {
      await pairAcrossTheNetwork(page, host);
      await page.goto("/");
      await openNewTerminal(page);
      await context.setOffline(true);
      await expect(page.getByRole("contentinfo").getByRole("status").filter({ hasText: OFFLINE })).toBeVisible({
        timeout: 2_000,
      });
      await context.setOffline(false);
      await expect(notice(page, OFFLINE)).toHaveCount(0, { timeout: 2_000 });
      await echoes(page, "back-online");
    });

    test("offline, the status bar says what happens next in visible text with an action, and no machine still shows connected (#475, #476)", async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await pairAcrossTheNetwork(page, host);
      await page.goto("/");
      await expect(onlineDot(page).first()).toBeVisible({ timeout: 20_000 });
      await context.setOffline(true);
      const bar = page.getByRole("contentinfo");
      await expect(bar.getByText(NEXT_STEP)).toBeVisible({ timeout: 2_000 });
      await expect(bar.getByRole("button", { name: "Try again" })).toBeVisible();
      await expect(onlineDot(page)).toHaveCount(0);
      await context.setOffline(false);
      await expect(onlineDot(page).first()).toBeVisible({ timeout: 20_000 });
    });
  });

  test("a link to this computer is never called Offline while the OS reports no network", async ({ page }) => {
    await page.goto("/");
    await openNewTerminal(page);
    // Wi-Fi off: navigator.onLine turns false and `offline` fires, while 127.0.0.1 keeps answering.
    await osOnline(page, false);
    await echoes(page, "loopback-still-works");
    await expect(notice(page, /Offline|Reconnecting/)).toHaveCount(0);
  });

  test("with the OS offline, a link to this computer that really drops says Reconnecting, never Offline, and clears on online", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const socket = await routeHcSocket(page);
    await page.goto("/");
    await openNewTerminal(page);
    const opened = socket.opened();
    await osOnline(page, false);
    await socket.drop(true);
    await expect(notice(page, RECONNECTING)).toBeVisible({ timeout: 2_000 });
    await expect(notice(page, OFFLINE)).toHaveCount(0);
    // Four refused attempts leave the next one 10 s away; the notice keeps saying Reconnecting meanwhile.
    await expect.poll(socket.refused, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
    await expect(notice(page, /Reconnecting in ([6-9]|10) s/)).toBeVisible({ timeout: 5_000 });
    await expect(notice(page, OFFLINE)).toHaveCount(0);
    socket.restore();
    await osOnline(page, true);
    await expect(notice(page, RECONNECTING)).toHaveCount(0, { timeout: 3_000 });
    expect(socket.opened() - opened).toBe(1);
    await echoes(page, "loopback-back");
  });

  test("back online, a reconnect waiting out its longest back-off starts at once, on one new socket", async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    const socket = await routeHcSocket(page);
    await page.goto("/");
    await openNewTerminal(page);
    const opened = socket.opened();
    await socket.drop(true);
    // Four refused attempts (0.5 + 1 + 2 + 5 s) leave the next one 10 s away; only that wait counts down from above 5.
    await expect.poll(socket.refused, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
    await expect(notice(page, /Reconnecting in ([6-9]|10) s/)).toBeVisible({ timeout: 5_000 });
    socket.restore();
    await context.setOffline(true);
    await context.setOffline(false);
    await expect(notice(page, RECONNECTING)).toHaveCount(0, { timeout: 3_000 });
    expect(socket.opened() - opened).toBe(1);
    await echoes(page, "back-at-once");
  });

  test("a link that goes silent past the heartbeat budget is closed and reconnected", async ({ page }) => {
    // Three missed core heartbeats (15 s apart) are the budget; the wait is the behaviour under test.
    test.setTimeout(150_000);
    const socket = await routeHcSocket(page);
    await page.goto("/");
    await openNewTerminal(page);
    const opened = socket.opened();
    // No reset, no close: every frame from the host stops, as when Wi-Fi goes away under an open socket.
    const release = socket.holdFromHost("");
    await expect(notice(page, RECONNECTING)).toBeVisible({ timeout: 60_000 });
    release();
    await expect.poll(socket.opened, { timeout: 20_000 }).toBeGreaterThan(opened);
    await expect(notice(page, RECONNECTING)).toHaveCount(0, { timeout: 20_000 });
    await echoes(page, "after-silence");
  });
});

async function openPhoneTerminal(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  await expect(page.locator("[data-terminal]")).toContainText("$", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Back to agents" })).toBeVisible();
}

test.describe("phone", () => {
  test.use({ ...phone });

  test.describe("a host across the network", () => {
    let host: FakeRelayHost;
    test.beforeAll(async () => {
      test.setTimeout(60_000);
      host = await startFakeRelayHost({ machine: true });
    });
    test.afterAll(async () => host.stop());

    test("the phone terminal screen says it is offline, and clears when the network is back", async ({
      page,
      context,
    }) => {
      await pairAcrossTheNetwork(page, host);
      await openPhoneTerminal(page);
      await context.setOffline(true);
      await expect(notice(page, OFFLINE)).toBeVisible({ timeout: 2_000 });
      await glyphCentredOnFirstLine(notice(page, OFFLINE));
      await context.setOffline(false);
      await expect(notice(page, OFFLINE)).toHaveCount(0, { timeout: 2_000 });
    });

    test("offline, the phone's list says what happens next in visible text, and no machine still shows connected (#475, #476)", async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await pairAcrossTheNetwork(page, host);
      // The machines are the phone's Spaces tab (mobile nav phase 3).
      await page.goto("/?v=spaces");
      await expect(page.getByRole("heading", { level: 1, name: "Spaces" })).toBeVisible({ timeout: 20_000 });
      await expect(onlineDot(page).first()).toBeVisible({ timeout: 20_000 });
      await context.setOffline(true);
      const sentence = page.getByText(NEXT_STEP).filter({ visible: true }).first();
      await expect(sentence).toBeVisible({ timeout: 2_000 });
      // The whole sentence is read, not cut behind an ellipsis.
      expect(await sentence.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      const retry = page.getByRole("button", { name: "Try again" }).filter({ visible: true }).first();
      const box = await retry.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
      await expect(onlineDot(page)).toHaveCount(0);
      await context.setOffline(false);
    });

    for (const width of [390, 320]) {
      test(`at ${width} px the offline line shows its whole sentence, wrapped, not cut off`, async ({
        page,
        context,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await pairAcrossTheNetwork(page, host);
        await openPhoneTerminal(page);
        await context.setOffline(true);
        const line = notice(page, OFFLINE);
        await expect(line).toBeVisible({ timeout: 2_000 });
        await expect(line).toHaveText("Offline. Reconnects when the network is back.");
        // Every part of the line fits its box: nothing is clipped behind an ellipsis.
        const clipped = await line.evaluate(
          (el) => [el, ...el.querySelectorAll("*")].filter((node) => node.scrollWidth > node.clientWidth + 1).length,
        );
        expect(clipped).toBe(0);
        const box = await line.boundingBox();
        expect(box?.x).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
        await context.setOffline(false);
      });
    }
  });

  test("the phone terminal screen says it is reconnecting while the host link is down", async ({ page }) => {
    const socket = await routeHcSocket(page);
    await openPhoneTerminal(page);
    await socket.drop(true);
    await expect(notice(page, RECONNECTING)).toBeVisible({ timeout: 5_000 });
    await glyphCentredOnFirstLine(notice(page, RECONNECTING));
    // The terminal stays on screen under the notice.
    await expect(page.locator("[data-terminal]")).toBeVisible();
    socket.restore();
    await expect(notice(page, RECONNECTING)).toHaveCount(0, { timeout: 20_000 });
    await echoes(page, "phone-back");
  });
});
