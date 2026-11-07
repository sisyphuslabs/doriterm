import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

// Storage blocked outright: touching window.localStorage or window.sessionStorage at all throws, as Chromium does when
// site settings block storage (#553), not just their getItem (storage-refused.e2e.ts).
const REFUSE_STORAGE = `for (const name of ["localStorage", "sessionStorage"]) {
  Object.defineProperty(window, name, {
    configurable: true,
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });
}`;

async function openWithStorageRefused(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript({ content: REFUSE_STORAGE });
  await page.goto("/");
  expect(
    await page.evaluate(() => {
      try {
        return typeof window.localStorage;
      } catch (error) {
        return error instanceof DOMException ? error.name : "other";
      }
    }),
  ).toBe("SecurityError");
  return errors;
}

test("with the storage getters throwing, the app starts on pairing and Settings works (#553)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await openWithStorageRefused(page);
  // No saved host can be read, so the app opens on pairing; Settings is reached by its address.
  await expect(page.getByRole("heading", { name: "Connect to a host" })).toBeVisible();
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings$/);
  const nav = page.getByRole("navigation", { name: "Settings" });
  await nav.getByRole("button", { name: "Appearance" }).click();
  await expect(page.getByLabel("Appearance", { exact: true }).getByRole("button", { name: "System" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await nav.getByRole("button", { name: "This device" }).click();
  await expect(page.getByRole("switch", { name: "Keep the screen awake" })).not.toBeChecked();
  expect(errors).toEqual([]);
});

test.describe("on the phone", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("with the storage getters throwing, the app starts on pairing and Settings works (#553)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = await openWithStorageRefused(page);
    await expect(page.getByRole("heading", { name: "Connect to a host" })).toBeVisible();
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await page.getByRole("tab", { name: "Appearance" }).click();
    await expect(
      page.getByLabel("Appearance", { exact: true }).getByRole("button", { name: "System" }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("tab", { name: "This device" }).click();
    await expect(page.getByRole("switch", { name: "Keep the screen awake" })).not.toBeChecked();
    expect(errors).toEqual([]);
  });
});
