import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { fakeSoftKeyboard, key, keysBar, PHONE } from "./phone-key-bar.ts";

// A narrow desktop window driven by a mouse and a physical keyboard: the phone shell, with no soft keyboard (#287).
test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, hasTouch: false, isMobile: false });

async function openTerminal(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(false);
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  const terminal = page.locator("[data-terminal]");
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  return { terminal, input: page.locator("[data-terminal] textarea") };
}

test("with a mouse, Show keys opens the keys bar itself, its keys reach the terminal, and Hide keys closes it", async ({
  page,
}) => {
  const { terminal, input } = await openTerminal(page);
  // A fine pointer has no soft keyboard to raise, so this surface still takes the focus as it opens (#1375).
  await expect(input).toBeFocused();
  await expect(keysBar(page)).toHaveCount(0);
  // Nothing claims a soft keyboard this device does not have (#274).
  await expect(key(page, "Show keyboard")).toHaveCount(0);

  await key(page, "Show keys").click();
  await expect(keysBar(page)).toBeVisible();
  await expect(input).toBeFocused();
  await expect(key(page, "Hide keyboard")).toHaveCount(0);

  await page.keyboard.type("echo fine-pointer-$((287+0))");
  await key(page, "Control").click();
  await page.keyboard.press("c");
  // Shells differ on echoing ^C at a prompt. The cancelled line must not run, and the next line must.
  await expect(key(page, "Control")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.type("\recho recovered-$((286+1))\r");
  await expect(terminal).toContainText("recovered-287");
  await expect(terminal).not.toContainText("fine-pointer-287");

  await key(page, "Hide keys").click();
  await expect(keysBar(page)).toHaveCount(0);
  await expect(key(page, "Show keys")).toBeVisible();
});

test.describe("on a touch phone", () => {
  test.use({ ...PHONE, serviceWorkers: "block" });

  test("the bar still rides on the soft keyboard, and the button says Show keyboard, not Show keys", async ({
    page,
  }) => {
    await fakeSoftKeyboard(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(true);
    await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
    await expect(page.locator("[data-terminal]")).toContainText("$", { timeout: 15_000 });
    await expect(key(page, "Show keyboard")).toBeVisible();
    await expect(key(page, "Show keys")).toHaveCount(0);
    await expect(key(page, "Hide keyboard")).toHaveCount(0);
    // The button is what raises the keyboard, and the bar rides it (#1375).
    await key(page, "Show keyboard").click();
    await expect(keysBar(page)).toBeVisible();
    await expect(key(page, "Hide keyboard")).toBeVisible();
  });
});
