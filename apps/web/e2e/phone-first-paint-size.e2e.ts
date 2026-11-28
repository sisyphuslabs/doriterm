import type { Locator, Page } from "@playwright/test";
import { startShell } from "./agents.ts";
import { coreSize, gridSize } from "./core-size.ts";
import { expect, test } from "./fixtures.ts";
import { seedLayout } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { PHONE } from "./phone-key-bar.ts";

// A phone opening the app on a terminal no other device is on draws it at its own box and gives the program that size,
// with nothing touched (#2987). The view measures its box as it attaches, which on a phone's first load is before the
// page has settled: the terminal's web font is often still on its way. Until #2987 a touch view only watching held its
// grid at that first measurement until the person typed, so the grid ran past the screen's edge and the program drew
// for it.
test.use({ ...PHONE, deviceScaleFactor: 3, serviceWorkers: "block" });

const shells: string[] = [];
test.afterEach(() => {
  for (const address of shells.splice(0)) hcOn("host", ["kill", address]);
});

/** The grid wterm fits the terminal's box to, as "rows cols": the content box over the W probe's cell and a row. */
const boxGrid = (terminal: Locator): Promise<string> =>
  terminal.evaluate((element) => {
    const cell = element.querySelector(".term-size-probe")?.getBoundingClientRect().width ?? 0;
    const row = element.querySelector(".term-row")?.getBoundingClientRect().height ?? 0;
    const style = getComputedStyle(element);
    const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    return `${Math.floor(height / row)} ${Math.floor(width / cell)}`;
  });

/** The grid fits the box, and the pty has the grid's size. */
async function sizedToBox(terminal: Locator, address: string): Promise<void> {
  await expect
    .poll(async () => (await gridSize(terminal)) === (await boxGrid(terminal)), { timeout: 15_000 })
    .toBe(true);
  await expect.poll(() => coreSize(address), { timeout: 15_000 }).toBe(await gridSize(terminal));
}

/** Opens a new shell's session straight from its address, as a phone's home-screen icon reopens it. */
async function openShell(page: Page, name: string): Promise<{ address: string; terminal: Locator }> {
  const address = startShell("host", name);
  shells.push(address);
  seedLayout([{ id: `tb-${name}`, root: [{ pane: "p1", terminal: address }] }]);
  await page.goto(`/?t=${encodeURIComponent(`local:${address}`)}`);
  const terminal = page.locator(`[data-terminal="${address}"]:visible`);
  await expect(terminal).toContainText("$", { timeout: 20_000 });
  return { address, terminal };
}

test("a first load whose web font arrives after the attach draws at the box and sizes the pty to it (#2987)", async ({
  page,
}) => {
  const font = Promise.withResolvers<void>();
  await page.route(/\.woff2$/, async (route) => {
    await font.promise;
    await route.continue();
  });
  const { address, terminal } = await openShell(page, "first-paint-font");
  // Attached and painted with the fallback font's cells: the first measurement is not the box the page settles on.
  const firstGrid = await gridSize(terminal);
  font.resolve();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  expect(await boxGrid(terminal)).not.toBe(firstGrid);
  await sizedToBox(terminal, address);
});

test("a box changed while the page was in the background is fitted on return, and the pty takes it (#2987)", async ({
  page,
}) => {
  const { address, terminal } = await openShell(page, "first-paint-return");
  await sizedToBox(terminal, address);
  const before = await gridSize(terminal);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // The browser's toolbars or the screen's orientation moved while the app was away.
  await page.setViewportSize({ width: 360, height: 700 });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(await boxGrid(terminal)).not.toBe(before);
  await sizedToBox(terminal, address);
});
