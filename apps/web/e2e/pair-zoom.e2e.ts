import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

/**
 * Whether the app cancelled the key. The app's dispatcher listens on `window` in the capture phase and may call
 * stopPropagation, which would keep the event from a later listener on another node; a capture listener added here
 * afterwards runs in the same phase, and `defaultPrevented` then says what the dispatcher did with the key.
 */
const cancellation = (page: Page): Promise<void> =>
  page.evaluate(() => {
    addEventListener(
      "keydown",
      (event) => {
        document.documentElement.dataset["keyCancelled"] = String(event.defaultPrevented);
      },
      { capture: true },
    );
  });

test("the pairing screen leaves the text-size key to the browser's own zoom (#1162)", async ({ page }) => {
  await page.goto("/pair");
  await expect(page.getByRole("heading", { name: "Join a mesh" })).toBeVisible({ timeout: 15_000 });
  await cancellation(page);
  await page.keyboard.press("ControlOrMeta+Equal");
  // Cancelled, the app would step a saved terminal font size nobody can see here and the page would not zoom.
  await expect(page.locator("html")).toHaveAttribute("data-key-cancelled", "false");
});

// The same symptom on the workspace route: a browser that has never paired sees the first-run Join a mesh screen there,
// so no terminal text is on screen to size either.
test("a browser's first-run screen on / leaves the text-size key to the browser's own zoom (#1162)", async ({
  page,
}) => {
  // The seeded page knows a host and opens its workspace; a fresh context carries no saved connection, as a new browser.
  await page.context().clearCookies();
  await page.addInitScript(() => localStorage.removeItem("doriface.connection"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Join a mesh" })).toBeVisible({ timeout: 15_000 });
  await cancellation(page);
  await page.keyboard.press("ControlOrMeta+Equal");
  await expect(page.locator("html")).toHaveAttribute("data-key-cancelled", "false");
});
