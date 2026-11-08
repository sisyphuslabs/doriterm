import type { Page } from "@playwright/test";
import { E2E_HOST_PORT } from "./config.ts";
import { expect, test } from "./fixtures.ts";
import { LAN_HC_URL } from "./hc-socket.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const OFFLINE_NOTICE = /You are offline/;
/** A loopback port nothing listens on (port 1, privileged and unused): the connect is refused, not closed. */
const REFUSED_URL = "ws://127.0.0.1:1/v1/hc";

const osOfflineFromStart = (page: Page) =>
  page.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: () => false }),
  );

/** Closes every link to `url` with 1011 as the gateway does when the host is down; returns how many it closed. */
function gatewayDown(page: Page, url: string): Promise<() => number> {
  let count = 0;
  return page
    .routeWebSocket(url, (socket) => {
      count += 1;
      void socket.close({ code: 1011, reason: "host unreachable" });
    })
    .then(() => () => count);
}

/** Why the page cannot reach the host when the link closes without a code it names (hostFailure's fallback). */
const CAUSE = "Your host isn't answering. Check that its computer is on and doriface-host is running.";

/**
 * Page time stands still at CLOCK_START from before the first load: the back-off's timer never fires, so after the first
 * attempt fails only a click on Try now can start another.
 */
const CLOCK_START = new Date("2026-01-01T00:00:00Z").getTime();
/** How far ahead of `install` the clock is stopped: past whatever it ran while the pause was on its way. */
const CLOCK_PAUSE_STEP_MS = 200;

/** How many WebSockets the page has opened to `url` that no route intercepts, counted from before the first load. */
function attemptsTo(page: Page, url: string): () => number {
  let count = 0;
  page.on("websocket", (socket) => {
    if (socket.url() === url) count += 1;
  });
  return () => count;
}

/** Opens the app with the OS offline and the first connect to `url` failing: closed 1011 when routed, else refused. */
async function firstConnectFails(page: Page, url: string, routed = true): Promise<() => number> {
  await page.clock.install({ time: CLOCK_START });
  // The clock runs from `install` until it is paused, so a pause at the clock's own time is already behind it. This
  // pause is a step ahead instead: far shorter than the back-off's first retry, so stopping there fires no timer.
  await page.clock.pauseAt(CLOCK_START + CLOCK_PAUSE_STEP_MS);
  await osOfflineFromStart(page);
  const attempts = routed ? await gatewayDown(page, url) : attemptsTo(page, url);
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Cannot reach your host" })).toBeVisible({ timeout: 15_000 });
  return attempts;
}

/** The failed first connect says why, and offers its next steps: Try now starts a new attempt, Open settings is there. */
async function saysWhyWithNextSteps(page: Page, attempts: () => number): Promise<void> {
  const failed = page.getByRole("status").filter({ hasText: "Cannot reach your host" });
  await expect(failed).toContainText(CAUSE);
  await expect(page.getByRole("link", { name: "Open settings" })).toBeVisible();
  const before = attempts();
  await page.getByRole("button", { name: "Try now" }).click();
  await expect.poll(attempts, { timeout: 15_000 }).toBeGreaterThan(before);
}

test.describe("the first-connect screen while the OS reports no network", () => {
  test("a link to this computer that fails is not blamed on the network, and says why with its next steps", async ({
    page,
  }) => {
    const attempts = await firstConnectFails(page, `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`);
    await expect(page.getByRole("status").filter({ hasText: OFFLINE_NOTICE })).toHaveCount(0);
    await saysWhyWithNextSteps(page, attempts);
  });

  test.describe("this computer's port refusing the link", () => {
    test.use({ loopbackUrl: REFUSED_URL });

    test("says why with its next steps, and is not blamed on the network", async ({ page }) => {
      const attempts = await firstConnectFails(page, REFUSED_URL, false);
      await expect(page.getByRole("status").filter({ hasText: OFFLINE_NOTICE })).toHaveCount(0);
      await saysWhyWithNextSteps(page, attempts);
    });
  });

  test.describe("a host across the network", () => {
    test.use({ loopbackUrl: LAN_HC_URL });

    test("a failed first connect also says the device is offline", async ({ page }) => {
      await firstConnectFails(page, LAN_HC_URL);
      await expect(page.getByRole("status").filter({ hasText: OFFLINE_NOTICE })).toBeVisible();
    });
  });
});

test("with nothing configured yet, the first-run screen keeps its next steps and says the device is offline", async ({
  page,
}) => {
  // No host chosen: the fixture's loopback settings are removed again before the app reads them.
  await page.addInitScript(() => localStorage.removeItem("doriface.connection"));
  await osOfflineFromStart(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Join a mesh" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("status").filter({ hasText: OFFLINE_NOTICE })).toBeVisible();
  // Pairing needs a network, so it is not the enabled first step while offline.
  await expect(page.getByRole("link", { name: "Pair a host" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Paste invite" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Paste invite" })).toHaveAccessibleDescription(/needs a network/);
});

test("the pairing page says the device is offline, and a lookup that cannot reach the relay promises no QR scan", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.removeItem("doriface.connection"));
  await osOfflineFromStart(page);
  await page.route(/\/v1\/pair\//, (route) => route.abort("internetdisconnected"));
  await page.goto("/pair");
  await expect(page.getByRole("heading", { name: "Join a mesh" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("status").filter({ hasText: OFFLINE_NOTICE })).toBeVisible();
  await page.getByLabel("Invite link or code").fill("ABCD2345");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    window.dispatchEvent(new Event("online"));
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const reason = page.getByText(/relay cannot be reached/);
  await expect(reason).toBeVisible({ timeout: 15_000 });
  await expect(reason).not.toContainText(/scan/i);
});
