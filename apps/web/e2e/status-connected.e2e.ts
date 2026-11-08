import type { Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { endOwnTerminals } from "./own-terminals.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

endOwnTerminals();

const bar = (page: Page) => page.getByRole("contentinfo");
const connected = (page: Page) => bar(page).getByText("Connected", { exact: true });

test("the status bar says Connected while the session is healthy, and only then (#1456)", async ({ page }) => {
  const socket = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  await expect(connected(page)).toBeVisible({ timeout: 15_000 });
  // The place reads as one breadcrumb: machine, then space, with a separator a screen reader skips.
  await expect(bar(page).locator("[data-status-place-separator]")).toHaveAttribute("aria-hidden", "true");

  await socket.drop(true);
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting" })).toBeVisible();
  await expect(connected(page)).toHaveCount(0);

  socket.restore();
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting" })).toBeHidden({ timeout: 15_000 });
  await expect(connected(page)).toBeVisible();
});
