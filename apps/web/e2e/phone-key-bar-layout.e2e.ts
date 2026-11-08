import { KEYBOARD_REQUEST_MS } from "../src/terminal/keyboard-inset.ts";
import { expect, test } from "./fixtures.ts";
import { key, keysBar, openPhoneTerminal } from "./phone-key-bar.ts";

// A touch phone whose browser resizes the page for its soft keyboard. A mouse-only window of this width opens the keys
// bar by hand instead (phone-keys-mouse.e2e.ts, #287). The service worker reloads the page once it takes control; only
// pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", hasTouch: true, isMobile: true });

// A browser that resizes the page for the soft keyboard instead of overlaying it (#244). A phone in landscape stays
// under the phone layout's 768 px.
const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 667, height: 375 };
const KEYBOARD = 336;
const LANDSCAPE_KEYBOARD = 190;

test("entering split screen with the terminal focused is no keyboard: no key bar, and leaving it keeps the focus", async ({
  page,
}) => {
  await page.clock.install();
  await openPhoneTerminal(page, PORTRAIT.width, "resize");
  const input = page.locator("[data-terminal] textarea");
  await expect(input).toBeFocused();
  // Long after anything asked for a keyboard, the window is halved for split screen.
  await page.clock.runFor(KEYBOARD_REQUEST_MS + 1000);
  // The keyboard was asked for (openPhoneTerminal presses the toggle), so the toggle stays pressed with no bar.
  await page.setViewportSize({ width: PORTRAIT.width, height: 420 });
  await expect(key(page, "Hide keyboard")).toHaveAttribute("aria-pressed", "true");
  await expect(keysBar(page)).toHaveCount(0);

  await page.setViewportSize(PORTRAIT);
  await expect(key(page, "Hide keyboard")).toHaveAttribute("aria-pressed", "true");
  await expect(input).toBeFocused();

  // With the keyboard asked for, a tap in the terminal in split screen raises one, measured from the half screen.
  await page.setViewportSize({ width: PORTRAIT.width, height: 420 });
  await page.locator("[data-terminal]").click();
  await page.setViewportSize({ width: PORTRAIT.width, height: 420 - 200 });
  await expect(keysBar(page)).toBeVisible();
});

test("rotating with the keyboard up keeps the key bar up, until the keyboard closes", async ({ page }) => {
  await openPhoneTerminal(page, PORTRAIT.width, "resize");
  const input = page.locator("[data-terminal] textarea");
  await page.locator("[data-terminal]").click();
  await page.setViewportSize({ width: PORTRAIT.width, height: PORTRAIT.height - KEYBOARD });
  const bar = keysBar(page);
  await expect(bar).toBeVisible();

  await page.setViewportSize({ width: LANDSCAPE.width, height: LANDSCAPE.height - LANDSCAPE_KEYBOARD });
  await expect(bar).toBeVisible();
  await expect(input).toBeFocused();

  // It closes by its own key: the page grows back, the bar goes, and the terminal lets go of the focus.
  await page.setViewportSize(LANDSCAPE);
  await expect(bar).toHaveCount(0);
  await expect(key(page, "Show keyboard")).toBeVisible();
  await expect(input).not.toBeFocused();
});
