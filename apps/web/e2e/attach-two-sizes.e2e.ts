// #2670: a phone opening a terminal a desktop already watches does not size the pty down to the phone: the pane in
// use answers a size below its own grid, so the program keeps laying out for the wider viewer and the desktop never
// shows a phone-wide column until it alone is used.
import type { Browser, Page } from "@playwright/test";
import { endAgent, startShell } from "./agents.ts";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { coreSize, gridSize } from "./core-size.ts";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { fakeSoftKeyboard } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block" });

/** A phone on the e2e core: its own context, a phone viewport, and a soft keyboard that only a press raises. */
async function phoneOnSameCore(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const settings = {
    mode: "loopback",
    relayUrl: "wss://relay-doriface.omo.dev",
    directUrl: "",
    hostId: "",
    loopbackUrl: `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`,
    token: E2E_TOKEN,
  };
  await context.addInitScript((value) => localStorage.setItem("doriface.connection", value), JSON.stringify(settings));
  const page = await context.newPage();
  await fakeSoftKeyboard(page);
  return page;
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

    const phone = await phoneOnSameCore(browser);
    const phoneTerminal = phone.locator(`[data-terminal="${address}"]`);
    try {
      await phone.goto("/");
      await phone
        .getByRole("button", { name: /two-sizes/ })
        .first()
        .click();
      await expect(phoneTerminal).toBeVisible({ timeout: 20_000 });
      // The phone's view attaches and would size the pty to its own 38-odd columns; the desktop, in use, answers.
      await expect.poll(() => coreSize(address), { timeout: 10_000 }).toBe(own);
      // The phone's own focus (a person about to type) does not take the columns either: the pane in use keeps them,
      // and the two converge on the larger one instead of trading the size back and forth.
      await phoneTerminal.getByRole("textbox").focus();
      await expect.poll(() => coreSize(address), { timeout: 10_000 }).toBe(own);
      expect(await gridSize(desktop)).toBe(own);
    } finally {
      await phone.close();
    }
  } finally {
    endAgent("host", address);
  }
});
