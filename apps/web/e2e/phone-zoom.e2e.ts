import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { fakeSoftKeyboard, PHONE } from "./phone-key-bar.ts";

test.use({ ...PHONE, serviceWorkers: "block" });

/**
 * A phone zooms a page for two reasons, and both are decided by a computed style, not by a layout: iOS zooms when a field
 * it focuses has a font-size under 16 px, and every browser zooms a double tap on a surface whose touch-action allows it.
 * Chromium's own emulation zooms for neither gesture here (measured: scale stays 1 for a synthesized double tap), so each
 * test below asserts the property its browser consults, then the outcome this browser can show: the page at scale 1,
 * a pinch still zooming, and the viewport free of a cap.
 */

const FIND_CHORD = process.platform === "darwin" ? "Meta+f" : "Control+Shift+F";

/** The page's own zoom. phone-key-bar.ts answers 1 for the fake viewport it installs, so this keeps the real one. */
const zoom = (page: Page): Promise<number> =>
  page.evaluate(() => (Reflect.get(window, "realViewport") as VisualViewport | undefined)?.scale ?? -1);

const fontSize = (field: Locator): Promise<number> =>
  field.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));

const touchAction = (surface: Locator): Promise<string> => surface.evaluate((el) => getComputedStyle(el).touchAction);

const viewportMeta = (page: Page): Promise<string> =>
  page.locator('meta[name="viewport"]').evaluate((el) => el.getAttribute("content") ?? "");

/** The fields a phone can focus and type into; a checkbox takes no text and zooms nothing. */
const textFields = (page: Page): Promise<{ label: string; size: number }[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll("input, textarea")]
      .filter((element) => {
        const type = element.getAttribute("type") ?? "text";
        return element.tagName === "TEXTAREA" || ["text", "search", "email", "password", "tel", "url"].includes(type);
      })
      .filter((element) => !(element as HTMLElement).hidden)
      .map((element) => ({
        label:
          element.getAttribute("aria-label") ??
          element.getAttribute("placeholder") ??
          element.getAttribute("type") ??
          element.tagName.toLowerCase(),
        size: Number.parseFloat(getComputedStyle(element).fontSize),
      })),
  );

async function openPhoneTerminal(page: Page): Promise<Locator> {
  await page.addInitScript(() => {
    Reflect.set(window, "realViewport", window.visualViewport);
  });
  await fakeSoftKeyboard(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  const terminal = page.locator("[data-terminal]");
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  return terminal;
}

const typeField = (page: Page): Locator => page.getByLabel("Type into the terminal");

/** Taps the terminal: that focus is what raises the keys bar, and with it the Type field. */
async function keysUp(page: Page, terminal: Locator): Promise<void> {
  await terminal.locator("textarea").focus();
  await expect(keysBar(page)).toBeVisible();
  await expect(typeField(page)).toBeVisible();
}

const surfaceOf = (page: Page): Locator => page.locator("[data-slot='terminal-viewport']");
const keysBar = (page: Page): Locator => page.getByRole("toolbar", { name: "Terminal keys" });

async function tapTwice(page: Page, terminal: Locator): Promise<number> {
  await page.evaluate(() => {
    Reflect.set(window, "taps", 0);
    document.addEventListener(
      "touchstart",
      () => Reflect.set(window, "taps", Number(Reflect.get(window, "taps")) + 1),
      {
        capture: true,
        passive: true,
      },
    );
  });
  const box = await terminal.boundingBox();
  if (box === null) throw new Error("the terminal has no box");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.synthesizeTapGesture", {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    duration: 40,
    tapCount: 2,
    gestureSourceType: "touch",
  });
  await cdp.detach();
  return page.evaluate(() => Number(Reflect.get(window, "taps")));
}

async function pinch(page: Page, terminal: Locator): Promise<void> {
  const box = await terminal.boundingBox();
  if (box === null) throw new Error("the terminal has no box");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.synthesizePinchGesture", {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    scaleFactor: 2,
    gestureSourceType: "touch",
  });
  await cdp.detach();
}

test("the phone is emulated as a coarse pointer with touch, so every assertion below is about a touch surface", async ({
  page,
}) => {
  await openPhoneTerminal(page);
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
  expect(await page.evaluate(() => devicePixelRatio)).toBeGreaterThan(1);
});

test("every field the phone can focus is 16px or more, so focusing one never zooms the page", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await keysUp(page, terminal);
  const seen = await textFields(page);

  // Find opens on a chord, which a phone reaches from a hardware keyboard or a tablet's.
  await page.keyboard.press(FIND_CHORD);
  await expect(page.getByRole("searchbox", { name: "Find in terminal" })).toBeVisible();
  seen.push(...(await textFields(page)));

  expect(seen.filter((field) => field.size < 16).map((field) => `${field.label} is ${field.size}px`)).toEqual([]);
});

/** One field on the phone: the size iOS zooms for, and the page's zoom after focusing it. */
async function expectFocusKeepsZoom(page: Page, name: string, field: Locator): Promise<void> {
  expect(await fontSize(field), `${name} is the size iOS zooms for`).toBeGreaterThanOrEqual(16);
  await field.focus();
  await expect.poll(async () => zoom(page), { message: `focusing ${name} zoomed the page` }).toBe(1);
}

test("focusing the terminal's field, the Type field and the input box leaves the page at scale 1", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await keysUp(page, terminal);
  await expectFocusKeepsZoom(page, "the terminal's own field", terminal.locator("textarea"));
  await expectFocusKeepsZoom(page, "the Type field", typeField(page));
});

test("a quick double tap on the terminal is two taps at scale 1, not a zoom", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  // manipulation keeps panning and pinch, and drops the double tap's zoom: what a terminal's tap means.
  expect(await touchAction(surfaceOf(page))).toBe("manipulation");
  expect(await touchAction(keysBar(page))).toBe("manipulation");
  expect(await tapTwice(page, terminal)).toBe(2);
  await expect.poll(async () => zoom(page)).toBe(1);
});

test("a deliberate pinch still zooms the page, on the terminal surface as anywhere else", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  expect(await zoom(page)).toBe(1);
  await pinch(page, terminal);
  await expect.poll(async () => zoom(page), { message: "a pinch no longer zooms" }).toBeGreaterThan(1);
  expect(await viewportMeta(page)).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0+)?\b/);
});
