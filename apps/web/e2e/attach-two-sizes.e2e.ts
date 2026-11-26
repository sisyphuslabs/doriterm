// #2670: a phone opening a terminal a desktop already shows does not size the pty down to the phone. A view that only
// watches never sizes the host (D1, host-size.ts); the device a person types on does, so the desktop keeps its columns.
import type { Browser, Page } from "@playwright/test";
import { endAgent, startShell } from "./agents.ts";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { coreSize, gridSize } from "./core-size.ts";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { fakeSoftKeyboard } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block" });

/**
 * A phone on the e2e core for the length of `run`: its own context, a phone viewport, and a soft keyboard that only a
 * press raises. The context is closed however `run` or the phone's setup ends, so no page or session outlives the test.
 */
async function withPhone(browser: Browser, run: (phone: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const settings = {
      mode: "loopback",
      relayUrl: "wss://relay-doriface.omo.dev",
      directUrl: "",
      hostId: "",
      loopbackUrl: `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`,
      token: E2E_TOKEN,
    };
    await context.addInitScript(
      (value) => localStorage.setItem("doriface.connection", value),
      JSON.stringify(settings),
    );
    const phone = await context.newPage();
    await fakeSoftKeyboard(phone);
    await run(phone);
  } finally {
    await context.close();
  }
}

test("a phone opening the terminal a desktop watches leaves the desktop's columns their own width (#2670)", async ({
  page,
  browser,
}) => {
  const address = startShell("host", "two-sizes");
  try {
    seedSpaces([
      {
        id: "spc-two-sizes",
        name: "two-sizes",
        folder: "",
        tabs: [{ id: "tb-two-sizes", name: "", terminal: address }],
      },
    ]);
    await page.goto("/");
    const desktop = page.locator(`[data-terminal="${address}"]`);
    await expect(desktop).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => coreSize(address) === (await gridSize(desktop)), { timeout: 15_000 }).toBe(true);
    const own = await gridSize(desktop);

    await withPhone(browser, async (phone) => {
      const phoneTerminal = phone.locator(`[data-terminal="${address}"]`);
      await phone.goto("/");
      await phone
        .getByRole("button", { name: /two-sizes/ })
        .first()
        .click();
      await expect(phoneTerminal).toBeVisible({ timeout: 20_000 });
      // The phone only watches, so it attaches without taking the pty's size (D1): the program keeps the desktop's.
      await expect.poll(() => coreSize(address), { timeout: 10_000 }).toBe(own);
      // Its focus alone (a person about to type) does not take the size either; only its first input would.
      await phoneTerminal.getByRole("textbox").focus();
      await expect.poll(() => coreSize(address), { timeout: 10_000 }).toBe(own);
      expect(await gridSize(desktop)).toBe(own);
    });
  } finally {
    endAgent("host", address);
  }
});
