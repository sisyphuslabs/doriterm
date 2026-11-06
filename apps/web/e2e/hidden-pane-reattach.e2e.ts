import type { Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

/** The count terminal-view's hook records; -1 means the page never saw the hook, so the count is unknown, not zero. */
const attaches = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const log: unknown = Reflect.get(window, "__dorifaceAttachLog");
    return Array.isArray(log) ? log.length : -1;
  });

test("a pane out of view waits to re-attach until it is shown, so a drop replays a hidden tab once, when someone looks (#639)", async ({
  page,
}) => {
  // Three missed core heartbeats (15 s apart) are the budget the drop waits out; the wait is the behaviour under test.
  test.setTimeout(150_000);
  await page.addInitScript(() => {
    Reflect.set(window, "__dorifaceAttachLog", []);
  });
  const socket = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  // A second tab puts the first one out of view without unmounting it: that is the pane this issue is about.
  await openNewTerminal(page);
  await expect.poll(() => attaches(page)).toBe(2);

  const opened = socket.opened();
  // No reset, no close: every frame from the host stops, as when Wi-Fi goes away under an open socket.
  const release = socket.holdFromHost("");
  const reconnecting = page.getByRole("status").filter({ hasText: /Reconnecting/ });
  await expect(reconnecting).toBeVisible({ timeout: 60_000 });
  release();
  await expect.poll(socket.opened, { timeout: 20_000 }).toBeGreaterThan(opened);
  await expect(reconnecting).toHaveCount(0, { timeout: 20_000 });

  // One re-attach, from the pane on screen. The hidden one has nobody to show a replay to, so it waits.
  await expect.poll(() => attaches(page)).toBe(3);

  // Showing it is what pays for its replay, and only one attach pays it.
  await page.getByRole("tab").first().click();
  await expect.poll(() => attaches(page)).toBe(4);
});
