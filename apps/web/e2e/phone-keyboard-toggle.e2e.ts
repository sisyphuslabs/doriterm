import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { fakeSoftKeyboard, key, keysBar, showKeyboard } from "./phone-key-bar.ts";

// A touch phone: the keyboard toggle has to follow the keyboard itself, not the terminal's focus (#274), and opening a
// terminal raises no keyboard of its own — only the keyboard button does (#1375). A mouse-only window of this width
// opens the keys bar by hand instead (phone-keys-mouse.e2e.ts, #287).
test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function openTerminal(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  const terminal = page.locator("[data-terminal]");
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  return { input: page.locator("[data-terminal] textarea") };
}

async function expectDown(page: Page): Promise<void> {
  await expect(key(page, "Show keyboard")).toBeVisible();
  await expect(keysBar(page)).toHaveCount(0);
  await expect(key(page, "Hide keyboard")).toHaveCount(0);
}

async function expectUp(page: Page): Promise<void> {
  await expect(keysBar(page)).toBeVisible();
  await expect(key(page, "Hide keyboard")).toBeVisible();
  await expect(key(page, "Show keyboard")).toHaveCount(0);
}

test("opening a terminal raises no keyboard on its own: it stays down until the keyboard button asks for it (#1375)", async ({
  page,
}) => {
  // A phone whose keyboard rises for any focus: an opening that focuses the terminal raises it, as it did.
  await fakeSoftKeyboard(page);
  const { input } = await openTerminal(page);
  await expect(input).not.toBeFocused();
  await expectDown(page);

  // A press in the terminal is not a request for the keyboard: the field takes the focus, the keyboard stays down.
  await page.locator("[data-terminal]").click();
  await expect(input).toBeFocused();
  await expectDown(page);

  await key(page, "Show keyboard").click();
  await expect(input).toBeFocused();
  await expectUp(page);

  await key(page, "Hide keyboard").click();
  await expectDown(page);
  await expect(input).not.toBeFocused();
});

test("with the terminal focused and no keyboard up, the toggle reads Show keyboard; it reads Hide keyboard only while one covers the page", async ({
  page,
}) => {
  await fakeSoftKeyboard(page, { raiseOnFocus: false });
  const { input } = await openTerminal(page);
  // The button is what puts the focus in the terminal, now (#1375).
  await key(page, "Show keyboard").click();
  await expect(input).toBeFocused();
  await expectDown(page);

  await showKeyboard(page, 336);
  await expectUp(page);

  // Closed by its own key (Android back, the iPad hide key): Show keyboard again, and the terminal lets go of the focus.
  await showKeyboard(page, 0);
  await expectDown(page);
  await expect(input).not.toBeFocused();
});

test("a browser that shrinks the page for the keyboard: Show keyboard while it is down, Hide keyboard while it is up", async ({
  page,
}) => {
  const { input } = await openTerminal(page);
  await expect(input).not.toBeFocused();
  await expectDown(page);

  // A press in the terminal leaves the keyboard down (#1375); the button raises it, and this browser shrinks the page for it.
  await page.locator("[data-terminal]").click();
  await expect(input).toBeFocused();
  await expectDown(page);
  await key(page, "Show keyboard").click();
  await page.setViewportSize({ width: 390, height: 844 - 336 });
  await expectUp(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectDown(page);
  await expect(input).not.toBeFocused();
});

test("Hide keyboard and a tap outside put it down, Show keyboard brings it up, and the toggle says which each time", async ({
  page,
}) => {
  await fakeSoftKeyboard(page);
  const { input } = await openTerminal(page);
  // Nothing raises the keyboard on opening; the button does (#1375).
  await expectDown(page);

  await key(page, "Show keyboard").click();
  await expectUp(page);
  await expect(input).toBeFocused();

  await key(page, "Hide keyboard").click();
  await expectDown(page);
  await expect(input).not.toBeFocused();

  await key(page, "Show keyboard").click();
  await expectUp(page);
  await expect(input).toBeFocused();

  // A tap outside the terminal (its header) takes the focus, and with it the keyboard.
  await page.getByRole("banner").getByRole("heading").click();
  await expectDown(page);
});
