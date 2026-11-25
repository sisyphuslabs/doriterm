import type { CDPSession, Locator, Page } from "@playwright/test";
import { agentRow, endAgent, startShell } from "./agents.ts";
import { E2E_TOKEN } from "./config.ts";
import { coreSize, gridSize } from "./core-size.ts";
import { expect, test } from "./fixtures.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { openPhoneTerminal, PHONE, settledGrid } from "./phone-key-bar.ts";

// Pinch on a terminal changes its text size (#2787): the glyphs follow the fingers, the grid changes once on release,
// and a phone only watching a terminal another device types into leaves that terminal's size alone (D1).

test.use({ serviceWorkers: "block", ...PHONE });

endOwnTerminals();

interface Point {
  readonly x: number;
  readonly y: number;
}

async function twoFingers(cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", points: Point[]) {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(({ x, y }, id) => ({ x, y, id })) });
}

/** Two fingers land `from` px apart across the terminal's middle and spread or close to `to` px, in steps. */
async function pinch(page: Page, terminal: Locator, from: number, to: number, release = true): Promise<CDPSession> {
  const box = await terminal.boundingBox();
  if (box === null) throw new Error("the terminal has no box");
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  const pair = (gap: number): Point[] => [
    { x: cx - gap / 2, y: cy },
    { x: cx + gap / 2, y: cy },
  ];
  const cdp = await page.context().newCDPSession(page);
  await twoFingers(cdp, "touchStart", pair(from));
  for (let step = 1; step <= 8; step++) {
    // oxlint-disable-next-line no-await-in-loop -- each move lands after the last, as a finger's does
    await twoFingers(cdp, "touchMove", pair(from + ((to - from) * step) / 8));
  }
  if (release) await twoFingers(cdp, "touchEnd", []);
  return cdp;
}

const fontSize = (terminal: Locator) => terminal.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
const readout = (page: Page) => page.locator("[data-pinch-readout]");

test("a pinch resizes the text as the fingers move, and the grid and pty once, on release", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await settledGrid(page, terminal);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  const [sizeBefore, gridBefore, coreBefore] = [await fontSize(terminal), await gridSize(terminal), coreSize(address)];

  const cdp = await pinch(page, terminal, 80, 160, false);
  await expect(readout(page)).toHaveText(/^\d+(\.5)? pt · \d+ × \d+ on this phone$/);
  expect(await fontSize(terminal)).toBeGreaterThan(sizeBefore);
  // Mid-pinch the program is not asked to redraw: the pty keeps its size.
  expect(coreSize(address)).toBe(coreBefore);

  await twoFingers(cdp, "touchEnd", []);
  await expect(readout(page)).toHaveCount(0);
  await expect.poll(() => gridSize(terminal)).not.toBe(gridBefore);
  await settledGrid(page, terminal);
  expect(await fontSize(terminal)).toBeGreaterThan(sizeBefore);

  // Kept for this device: a reload draws at the pinched size.
  const pinched = await fontSize(terminal);
  await page.reload();
  const again = page.locator("[data-terminal]");
  await expect(again).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => fontSize(again)).toBe(pinched);
});

test("a two-finger double tap puts the device's size back", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  const start = await fontSize(terminal);
  await pinch(page, terminal, 160, 80);
  await expect.poll(() => fontSize(terminal)).toBeLessThan(start);
  const box = await terminal.boundingBox();
  if (box === null) throw new Error("the terminal has no box");
  const pair = [
    { x: box.x + 120, y: box.y + 100 },
    { x: box.x + 220, y: box.y + 100 },
  ];
  const cdp = await page.context().newCDPSession(page);
  for (let tap = 0; tap < 2; tap++) {
    // oxlint-disable-next-line no-await-in-loop -- the second tap follows the first
    await twoFingers(cdp, "touchStart", pair);
    // oxlint-disable-next-line no-await-in-loop -- a tap lifts before the next lands
    await twoFingers(cdp, "touchEnd", []);
  }
  await expect.poll(() => fontSize(terminal)).toBe(start);
});

test("a phone only watching leaves the size of the device typing; asking for the keyboard takes it", async ({
  page,
  browser,
  loopbackUrl,
}) => {
  const name = `d1-watch-${Date.now().toString(36)}`;
  const address = startShell("host", name);
  const deskContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const settings = { mode: "loopback", relayUrl: "", directUrl: "", hostId: "", loopbackUrl, token: E2E_TOKEN };
  await deskContext.addInitScript(
    (value) => localStorage.setItem("doriface.connection", value),
    JSON.stringify(settings),
  );
  const desk = await deskContext.newPage();
  try {
    await desk.goto("/");
    await agentRow(desk, name, false).click();
    const deskTerminal = desk.locator(`[data-terminal="${address}"]`);
    await deskTerminal.getByRole("textbox").focus();
    await desk.keyboard.insertText("echo desk");
    await desk.keyboard.press("Enter");
    await settledGrid(desk, deskTerminal);
    const deskSize = coreSize(address);

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
    await page
      .getByRole("button", { name: new RegExp(name) })
      .first()
      .click();
    const phoneTerminal = page.locator(`[data-terminal="${address}"]`);
    await expect(phoneTerminal).toContainText("desk", { timeout: 15_000 });
    await expect.poll(() => gridSize(phoneTerminal)).not.toBe(deskSize);
    expect(coreSize(address)).toBe(deskSize);

    await page.getByRole("button", { name: "Show keyboard", exact: true }).click();
    await settledGrid(page, phoneTerminal);
  } finally {
    await deskContext.close();
    endAgent("host", address);
  }
});
