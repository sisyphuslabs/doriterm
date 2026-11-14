import { devices, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { chatComposer, key, type KeyboardShape, keysBar, openPhoneTerminal, showKeyboard } from "./phone-key-bar.ts";

const { defaultBrowserType: _iphoneBrowser, ...IPHONE } = devices["iPhone 14"];
const { defaultBrowserType: _pixelBrowser, ...PIXEL } = devices["Pixel 7"];
const SIZE = { width: 390, height: 844 };

/**
 * The phone each engine stands for at 390x844 (#1409): WebKit is an iPhone, Chromium a Pixel. Run with
 * `E2E_BROWSERS=all --project=chromium --project=webkit` for both; the default run is Chromium alone.
 */
const phone = (browserName: string) => (browserName === "webkit" ? IPHONE : PIXEL);

test.use({
  serviceWorkers: "block",
  viewport: SIZE,
  screen: SIZE,
  userAgent: async ({ browserName }, use) => use(phone(browserName).userAgent),
  deviceScaleFactor: async ({ browserName }, use) => use(phone(browserName).deviceScaleFactor),
  isMobile: async ({ browserName }, use) => use(phone(browserName).isMobile),
  hasTouch: async ({ browserName }, use) => use(phone(browserName).hasTouch),
});

const field = (page: Page) => page.getByLabel("Type into the terminal");

/**
 * Chat's field lies inside the visual viewport, above its bottom edge (the keyboard's top), and the composer rides on the
 * keyboard: its bottom edge is the visual viewport's (#2604).
 */
async function expectAboveKeyboard(page: Page): Promise<void> {
  await expect(async () => {
    const [box, bar, viewport] = await Promise.all([
      field(page).boundingBox(),
      chatComposer(page).boundingBox(),
      page.evaluate(() => {
        const visual = window.visualViewport;
        if (visual === null) throw new Error("this page has no visual viewport");
        return { top: visual.offsetTop, bottom: visual.offsetTop + visual.height };
      }),
    ]);
    if (box === null || bar === null) throw new Error("the Type field or the keys bar is not on the page");
    expect(box.y, "the Type field's top edge against the visual viewport's top").toBeGreaterThanOrEqual(viewport.top);
    expect(box.y + box.height, "the Type field's bottom edge against the keyboard's top").toBeLessThanOrEqual(
      viewport.bottom,
    );
    expect(
      Math.abs(bar.y + bar.height - viewport.bottom),
      "the keys bar's bottom edge off the keyboard's top",
    ).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 5_000 });
}

/** The keyboard comes up only for the tap that asks for it, as on a phone: a focus alone raises none. */
const SHAPES: readonly { readonly name: string; readonly shape: KeyboardShape }[] = [
  // WebKit on iOS: window.innerHeight follows the visual viewport while the page keeps its height.
  { name: "an iOS keyboard", shape: { raiseOnFocus: false, innerHeightFollows: true, pan: 0 } },
  {
    name: "an iOS keyboard with the view scrolled down the page",
    shape: { raiseOnFocus: false, innerHeightFollows: true, pan: 120 },
  },
  // Chrome on Android: window.innerHeight stays the page's, and the visual viewport scrolls down it.
  {
    name: "an Android keyboard with the view scrolled down the page",
    shape: { raiseOnFocus: false, innerHeightFollows: false, pan: 120 },
  },
];

/** Presses the round keyboard button, and the soft keyboard comes up for that tap. */
async function pressShowKeyboard(page: Page): Promise<void> {
  await key(page, "Show keyboard").click();
  await showKeyboard(page, 336);
  await expect(keysBar(page)).toBeVisible();
}

for (const { name, shape } of SHAPES) {
  test(`under ${name}, the Type field stays in view above it, pressed or raised by the keyboard button (#1409)`, async ({
    page,
  }) => {
    await openPhoneTerminal(page, SIZE.width, shape);
    await pressShowKeyboard(page);
    await key(page, "Chat").click();
    await expect(field(page)).toBeFocused();
    await expectAboveKeyboard(page);
    await page.keyboard.type("echo typed-above-the-keyboard");
    await expect(field(page)).toHaveValue("echo typed-above-the-keyboard");
    await expectAboveKeyboard(page);

    // Closed, Chat keeps the line; opened again, it is back with what was typed still in it.
    await chatComposer(page).getByRole("button", { name: "Close chat" }).click();
    await expect(field(page)).toHaveCount(0);
    await expect(keysBar(page)).toBeVisible();
    await key(page, "Chat").click();
    await expect(field(page)).toHaveValue("echo typed-above-the-keyboard");
    await expectAboveKeyboard(page);
  });
}
