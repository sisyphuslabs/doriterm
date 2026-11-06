import type { Page } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { expect, openNewTerminal as openTerminal, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

/** Terminals these cases open, ended after each so later specs start from the same count. */
const opened: string[] = [];
test.afterEach(() => {
  for (const address of opened.splice(0)) endAgent("host", address);
});

async function openNewTerminal(page: Page) {
  const terminal = await openTerminal(page);
  const address = await terminal.getAttribute("data-terminal");
  if (address !== null) opened.push(address);
  return terminal;
}

interface Wake {
  readonly active: number;
  readonly requests: number;
}

/** Stands in for navigator.wakeLock, counting the locks it holds, as headless Chromium has no screen to keep on. */
async function fakeWakeLock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { active: 0, requests: 0 };
    const lock = {
      request: async () => {
        state.requests += 1;
        state.active += 1;
        const handle = new EventTarget();
        let released = false;
        return Object.assign(handle, {
          type: "screen",
          release: async () => {
            if (released) return;
            released = true;
            state.active -= 1;
            handle.dispatchEvent(new Event("release"));
          },
        });
      },
    };
    Object.defineProperty(Navigator.prototype, "wakeLock", { configurable: true, get: () => lock });
    Object.assign(window, { wake: state });
  });
}

const wake = (page: Page): Promise<Wake> => page.evaluate(() => ({ ...(Reflect.get(window, "wake") as Wake) }));

/** Hides or shows the page the way switching tabs or apps does. */
const setVisibility = (page: Page, state: "hidden" | "visible") =>
  page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);

async function openDevice(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Device" }).click();
}

test("keep the screen awake survives a reload and holds the lock only while a terminal is on screen", async ({
  page,
}) => {
  await fakeWakeLock(page);
  await page.goto("/settings");
  await openDevice(page);
  const toggle = page.getByRole("switch", { name: "Keep the screen awake" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await page.reload();
  await openDevice(page);
  await expect(toggle).toBeChecked();
  expect((await wake(page)).active).toBe(0);

  await page.goto("/");
  await openNewTerminal(page);
  await expect.poll(async () => (await wake(page)).active).toBe(1);
  await setVisibility(page, "hidden");
  await expect.poll(async () => (await wake(page)).active, { message: "released when hidden" }).toBe(0);
  await setVisibility(page, "visible");
  await expect.poll(async () => (await wake(page)).active, { message: "taken again when shown" }).toBe(1);

  // The Settings dialog leaves the terminals in view behind it, so the lock stays.
  await page.getByRole("link", { name: "Settings" }).first().click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  expect((await wake(page)).active).toBe(1);
  // On a screen too short for the dialog Settings is a sheet over the whole page, and no terminal shows.
  await page.setViewportSize({ width: 1280, height: 560 });
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  await expect.poll(async () => (await wake(page)).active, { message: "released once no terminal shows" }).toBe(0);
});

test("with the setting off, a terminal on screen takes no lock", async ({ page }) => {
  await fakeWakeLock(page);
  await page.goto("/");
  await openNewTerminal(page);
  expect(await wake(page)).toEqual({ active: 0, requests: 0 });
});

test("the setting is hidden where the browser has no wake lock", async ({ page }) => {
  await page.addInitScript(() => Reflect.deleteProperty(Navigator.prototype, "wakeLock"));
  await page.goto("/settings");
  await openDevice(page);
  await expect(page.getByRole("heading", { name: "This device" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Keep the screen awake" })).toHaveCount(0);
});
