import { devices, type Locator, type Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...iphone } = devices["iPhone 14"];
export const PHONE = { ...iphone, viewport: { width: 390, height: 844 } };

/**
 * Call before page.goto: replaces visualViewport with one that a 336 px soft keyboard shrinks while a text field has
 * the focus, as a phone's does; `showKeyboard(page, px)` moves it on its own (0: closed by its own key). Headless
 * Chromium has no soft keyboard. With `raiseOnFocus: false` a focus alone raises nothing (a keyboard only
 * `showKeyboard` brings up), as on a screen whose keyboard the person opens themselves.
 *
 * The keyboard's shape (#1409): `innerHeightFollows` makes `window.innerHeight` report the visual viewport, as WebKit on
 * iOS does, while the page itself (its `dvh` and `documentElement.clientHeight`) keeps its height; `pan` is how far
 * the browser scrolls the visual viewport down the page while the keyboard is up (its `offsetTop`), in CSS px.
 */
export async function fakeSoftKeyboard(
  page: Page,
  { raiseOnFocus = true, innerHeightFollows = false, pan = 0 } = {},
): Promise<void> {
  await page.addInitScript(
    ({ raise, follows, panned }) => {
      let keyboard = 0;
      const layout = (): number => (follows ? document.documentElement.clientHeight : window.innerHeight);
      if (follows) {
        Object.defineProperty(window, "innerHeight", { configurable: true, get: () => layout() - keyboard });
      }
      const viewport = Object.defineProperties(new EventTarget(), {
        height: { get: (): number => layout() - keyboard },
        width: { get: (): number => window.innerWidth },
        offsetTop: { get: (): number => (keyboard > 0 ? panned : 0) },
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
        if (raise && document.activeElement instanceof HTMLTextAreaElement && keyboard === 0) softKeyboard(336);
      });
      document.addEventListener("focusout", (event) => {
        const next = event.relatedTarget;
        queueMicrotask(() => {
          if (
            !(next instanceof HTMLTextAreaElement) &&
            !(document.activeElement instanceof HTMLTextAreaElement) &&
            keyboard > 0
          )
            softKeyboard(0);
        });
      });
      Object.assign(window, { softKeyboard });
    },
    { raise: raiseOnFocus, follows: innerHeightFollows, panned: pan },
  );
}

export async function showKeyboard(page: Page, px: number): Promise<void> {
  await page.evaluate((height) => (Reflect.get(window, "softKeyboard") as (px: number) => void)(height), px);
}

/** The shape of an overlay keyboard, as `fakeSoftKeyboard` takes it. */
export interface KeyboardShape {
  readonly raiseOnFocus: boolean;
  readonly innerHeightFollows: boolean;
  readonly pan: number;
}

/**
 * `overlay`: the soft keyboard covers the page and shrinks only the visual viewport (iOS Safari, Chrome's default);
 * a `KeyboardShape` is that keyboard in the shape given. `resize`: the browser shrinks the layout viewport for it
 * instead; the spec resizes the page to open it.
 */
export async function openPhoneTerminal(
  page: Page,
  width = 390,
  keyboard: "overlay" | "resize" | KeyboardShape = "overlay",
): Promise<Locator> {
  if (keyboard === "overlay") await fakeSoftKeyboard(page);
  else if (keyboard !== "resize") await fakeSoftKeyboard(page, keyboard);
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
