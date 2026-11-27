import { KEYBOARD_REQUEST_MS } from "../src/terminal/keyboard-inset.ts";
import { expect, test } from "./fixtures.ts";
import { key, keyboardFromTap, keysBar, openPhoneTerminal, resizeSeen } from "./phone-key-bar.ts";

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

test("entering split screen with the terminal focused is no keyboard: the keys stay down, and leaving it keeps the focus", async ({
  page,
}) => {
  await page.clock.install();
  await openPhoneTerminal(page, PORTRAIT.width, "resize");
  const input = page.locator("[data-terminal] textarea");
  await expect(input).toBeFocused();
  // Long after anything asked for a keyboard, the window is halved for split screen.
  await page.clock.runFor(KEYBOARD_REQUEST_MS + 1000);
  await resizeSeen(page, { width: PORTRAIT.width, height: 420 });
  await expect(key(page, "Show keyboard")).toBeVisible();
  await expect(key(page, "Hide keyboard")).toHaveCount(0);

  await resizeSeen(page, PORTRAIT);
  await expect(key(page, "Show keyboard")).toBeVisible();
  await expect(input).toBeFocused();

  // The keyboard button raises the keyboard in split screen, measured from the half screen (#1375).
  await resizeSeen(page, { width: PORTRAIT.width, height: 420 });
  await keyboardFromTap(page, key(page, "Show keyboard"), { width: PORTRAIT.width, height: 420 - 200 });
  await expect(key(page, "Hide keyboard")).toBeVisible();
});

test("rotating with the keyboard up keeps the key bar up, until the keyboard closes", async ({ page }) => {
  await page.clock.install();
  await openPhoneTerminal(page, PORTRAIT.width, "resize");
  const input = page.locator("[data-terminal] textarea");
  // The keyboard button asks for the keyboard; this browser shrinks the page for it (#1375).
  await keyboardFromTap(page, key(page, "Show keyboard"), {
    width: PORTRAIT.width,
    height: PORTRAIT.height - KEYBOARD,
  });
  const bar = keysBar(page);
  // The keys are on screen in both states (#2499): the toggle says which.
  await expect(key(page, "Hide keyboard")).toBeVisible();

  await resizeSeen(page, { width: LANDSCAPE.width, height: LANDSCAPE.height - LANDSCAPE_KEYBOARD });
  await expect(key(page, "Hide keyboard")).toBeVisible();
  await expect(input).toBeFocused();

  // It closes by its own key: the page grows back, the bar stays with only the keyboard gone (#2499), and the terminal
  // lets go of the focus.
  await resizeSeen(page, LANDSCAPE);
  await expect(bar).toBeVisible();
  await expect(key(page, "Hide keyboard")).toHaveCount(0);
  await expect(key(page, "Show keyboard")).toBeVisible();
  await expect(input).not.toBeFocused();
});
