import type { Browser, Page } from "@playwright/test";
import { startShell } from "./agents.ts";
import { E2E_TOKEN } from "./config.ts";
import { coreSize, gridSize } from "./core-size.ts";
import { expect, test } from "./fixtures.ts";
import { seedLayout } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { PHONE } from "./phone-key-bar.ts";

// A phone shows a terminal that a desktop also shows. Whichever view was active last sets the pty's size (herdr-core:
// it attached, typed, resized or gained focus); a phone's terminal takes no focus of its own, so once the desktop is
// active the program draws for the desktop's width while the phone's grid is narrower, and every redraw that moves
// the cursor up by the program's line count leaves a copy of the wrapped line behind on the phone.
test.use({ ...PHONE, serviceWorkers: "block" });

const shells: string[] = [];
test.afterEach(() => {
  for (const address of shells.splice(0)) hcOn("host", ["kill", address]);
});

/** A desktop window on this core: its own browser context, so its own storage and its own view of the terminal. */
async function desktopWindow(browser: Browser, loopbackUrl: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    screen: { width: 1280, height: 720 },
    hasTouch: false,
    isMobile: false,
    serviceWorkers: "block",
  });
  const settings = {
    mode: "loopback",
    relayUrl: "wss://relay-doriface.omo.dev",
    directUrl: "",
    hostId: "",
    loopbackUrl,
    token: E2E_TOKEN,
  };
  await context.addInitScript((value) => localStorage.setItem("doriface.connection", value), JSON.stringify(settings));
  return context.newPage();
}

/** The phone and a desktop window on one shell, the desktop active last. */
async function sharedShell(phonePage: Page, browser: Browser, loopbackUrl: string, name: string, startsInput: boolean) {
  const address = startShell("host", name);
  shells.push(address);
  seedLayout([{ id: `tb-${name}`, root: [{ pane: "p1", terminal: address }] }]);
  await phonePage.goto("/");
  await phonePage
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  const onPhone = phonePage.locator(`[data-terminal="${address}"]:visible`);
  await expect(onPhone).toContainText("$", { timeout: 20_000 });
  if (startsInput) {
    await phonePage.getByRole("button", { name: "Show keyboard", exact: true }).click();
    await expect.poll(() => coreSize(address), { timeout: 15_000 }).toBe(await gridSize(onPhone));
  }

  const desktopPage = await desktopWindow(browser, loopbackUrl);
  await desktopPage.goto("/");
  await desktopPage
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click({ timeout: 20_000 });
  const onDesktop = desktopPage.locator(`[data-terminal="${address}"]`);
  await expect(onDesktop).toContainText("$", { timeout: 20_000 });
  await onDesktop.getByRole("textbox").focus();
  await expect.poll(() => coreSize(address), { timeout: 15_000 }).toBe(await gridSize(onDesktop));
  // A phone in use draws its own grid, which a reclaim gives the pty; one only watching draws the pty's (#2974).
  if (startsInput) expect(await gridSize(onDesktop)).not.toBe(await gridSize(onPhone));
  else await expect.poll(() => gridSize(onPhone), { timeout: 10_000 }).toBe(await gridSize(onDesktop));
  return { address, onPhone, deskSize: await gridSize(onDesktop) };
}

/** The page goes to the background and comes back, as switching apps or locking the phone does. */
async function backAndForth(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const state of ["hidden", "visible"] as const) {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
}

test("a phone that started input and comes back to a terminal the desktop took over reclaims the size", async ({
  page,
  browser,
  loopbackUrl,
}) => {
  const { address, onPhone } = await sharedShell(page, browser, loopbackUrl, "reclaim-visible", true);
  await backAndForth(page);
  await expect.poll(() => coreSize(address), { timeout: 15_000 }).toBe(await gridSize(onPhone));
});

test("a phone only watching does not reclaim the desktop's size on return (D1)", async ({
  page,
  browser,
  loopbackUrl,
}) => {
  const { address, onPhone, deskSize } = await sharedShell(page, browser, loopbackUrl, "watch-visible", false);
  await backAndForth(page);
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  expect(coreSize(address)).toBe(deskSize);
  expect(await gridSize(onPhone)).toBe(deskSize);
});
