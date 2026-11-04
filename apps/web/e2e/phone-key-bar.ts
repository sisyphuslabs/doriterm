import { devices, type Locator, type Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...iphone } = devices["iPhone 14"];
export const PHONE = { ...iphone, viewport: { width: 390, height: 844 } };

/**
 * Call before page.goto: replaces visualViewport with one that a 336 px soft keyboard shrinks while a text field has
 * the focus, as a phone's does; `showKeyboard(page, px)` moves it on its own (0: closed by its own key). Headless
 * Chromium has no soft keyboard.
 */
export async function fakeSoftKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let keyboard = 0;
    const viewport = Object.defineProperties(new EventTarget(), {
      height: { get: (): number => window.innerHeight - keyboard },
      width: { get: (): number => window.innerWidth },
      offsetTop: { get: (): number => 0 },
      offsetLeft: { get: (): number => 0 },
      pageTop: { get: (): number => window.scrollY },
      pageLeft: { get: (): number => window.scrollX },
      scale: { get: (): number => 1 },
    });
    Object.defineProperty(window, "visualViewport", { get: () => viewport });
    const softKeyboard = (px: number): void => {
      keyboard = px;
      viewport.dispatchEvent(new Event("resize"));
    };
    document.addEventListener("focusin", () => {
      if (document.activeElement instanceof HTMLTextAreaElement && keyboard === 0) softKeyboard(336);
    });
    document.addEventListener("focusout", () =>
      queueMicrotask(() => {
        if (!(document.activeElement instanceof HTMLTextAreaElement) && keyboard > 0) softKeyboard(0);
      }),
    );
    Object.assign(window, { softKeyboard });
  });
}

export async function showKeyboard(page: Page, px: number): Promise<void> {
  await page.evaluate((height) => (Reflect.get(window, "softKeyboard") as (px: number) => void)(height), px);
}

export async function openPhoneTerminal(page: Page, width = 390): Promise<Locator> {
  await fakeSoftKeyboard(page);
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  const terminal = page.locator("[data-terminal]");
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  return terminal;
}

export const keysBar = (page: Page) => page.getByRole("toolbar", { name: "Terminal keys" });
export const key = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

export async function expectTouchTargets(scope: Locator): Promise<void> {
  const small = await scope.getByRole("button").evaluateAll((buttons) =>
    buttons
      .map((button) => ({ name: button.getAttribute("aria-label") ?? "", box: button.getBoundingClientRect() }))
      .filter(({ box }) => box.width < 44 || box.height < 44)
      .map(({ name, box }) => `${name} ${Math.round(box.width)}x${Math.round(box.height)}`),
  );
  expect(small).toEqual([]);
}
