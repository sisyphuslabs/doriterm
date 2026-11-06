import { devices, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

/** Drops the browser's own beforeinstallprompt, so each case decides whether one arrives. */
async function noBrowserPrompt(page: Page): Promise<void> {
  await page.addInitScript(() =>
    addEventListener(
      "beforeinstallprompt",
      (event) => {
        if (event.isTrusted) event.stopImmediatePropagation();
      },
      { capture: true },
    ),
  );
}

/** Fires a beforeinstallprompt the way Chromium does once the app is installable; its prompt() is counted. */
const offerInstall = (page: Page) =>
  page.evaluate(() => {
    Object.assign(window, { prompted: 0 });
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: async () => {
        Object.assign(window, { prompted: Number(Reflect.get(window, "prompted")) + 1 });
        return { outcome: "accepted" };
      },
    });
    dispatchEvent(event);
    return event.defaultPrevented;
  });

const prompted = (page: Page) => page.evaluate(() => Number(Reflect.get(window, "prompted")));

async function openDevice(page: Page, phone = false): Promise<void> {
  await page.goto("/settings");
  await (
    phone
      ? page.getByRole("tab", { name: "This device" })
      : page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "This device" })
  ).click();
  await expect(page.getByRole("heading", { name: "This device" })).toBeVisible();
}

test.describe("desktop browser", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Install appears once the browser offers it, opens the browser's prompt and then goes away", async ({
    page,
  }) => {
    await noBrowserPrompt(page);
    await openDevice(page);
    const button = page.getByRole("button", { name: "Install", exact: true });
    await expect(button).toHaveCount(0);
    expect(await offerInstall(page)).toBe(true);
    await button.click();
    expect(await prompted(page)).toBe(1);
    await expect(button).toHaveCount(0);
  });

  test("an installed app offers no Install", async ({ page }) => {
    await noBrowserPrompt(page);
    await page.addInitScript(() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query: string) =>
        query === "(display-mode: standalone)" ? { ...original(query), matches: true } : original(query);
    });
    await openDevice(page);
    await offerInstall(page);
    await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
  });
});

test.describe("iPhone", () => {
  const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
  test.use(phone);

  test("shows how to add doriface to the home screen, with no Install button", async ({ page }) => {
    await noBrowserPrompt(page);
    await openDevice(page, true);
    await expect(page.getByText("In Safari, tap Share, then Add to Home Screen.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
  });
});
