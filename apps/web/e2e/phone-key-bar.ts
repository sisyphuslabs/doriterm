import { devices, type Locator, type Page } from "@playwright/test";
import { coreSize, gridSize } from "./core-size.ts";
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
 *
 * A field whose `inputmode` is `"none"` raises nothing either, as iOS and Chrome treat it: a phone's terminal keeps its
 * field that way until its keys ask for the keyboard (#1375).
 */
export async function fakeSoftKeyboard(
  page: Page,
  { raiseOnFocus = true, innerHeightFollows = false, pan: keyboardPan = 0 } = {},
): Promise<void> {
  await page.addInitScript(
    ({ raise, follows, panned }) => {
      let keyboard = 0;
      let pan = 0;
      const layout = (): number => (follows ? document.documentElement.clientHeight : window.innerHeight);
      if (follows) {
        Object.defineProperty(window, "innerHeight", { configurable: true, get: () => layout() - keyboard });
      }
      const viewport = Object.defineProperties(new EventTarget(), {
        height: { get: (): number => layout() - keyboard },
        width: { get: (): number => window.innerWidth },
        offsetTop: { get: (): number => pan + (keyboard > 0 ? panned : 0) },
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
        const active = document.activeElement;
        if (!raise || keyboard !== 0) return;
        // `inputmode="none"` is a focus that asks for no soft keyboard, as iOS and Chrome treat it (#1375).
        if (active instanceof HTMLTextAreaElement && active.inputMode !== "none") softKeyboard(336);
      });
      document.addEventListener("focusout", (event) => {
        const next = event.relatedTarget;
        queueMicrotask(() => {
          const active = document.activeElement;
          const wasTyping = next instanceof HTMLTextAreaElement && next.inputMode !== "none";
          const isTyping = active instanceof HTMLTextAreaElement && active.inputMode !== "none";
          if (!wasTyping && !isTyping && keyboard > 0) softKeyboard(0);
        });
      });
      // iOS pans the visual viewport (offsetTop) to keep a focused field in view; it fires scroll, not resize.
      const panTo = (px: number): void => {
        pan = px;
        viewport.dispatchEvent(new Event("scroll"));
      };
      Object.assign(window, { softKeyboard, panViewport: panTo });
    },
    { raise: raiseOnFocus, follows: innerHeightFollows, panned: keyboardPan },
  );
}

export async function panViewport(page: Page, px: number): Promise<void> {
  await page.evaluate((offset) => (Reflect.get(window, "panViewport") as (px: number) => void)(offset), px);
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
 *
 * A phone raises its keyboard only when the keys ask for it (#1375), so this opens the terminal and presses its keyboard
 * button, as a person does before typing.
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
  await key(page, "Show keyboard").click();
  // A keyboard that rises for the focus is up once the keys' toggle says so: the keys are on screen either way (#2499).
  const raises = keyboard === "overlay" || (keyboard !== "resize" && keyboard.raiseOnFocus);
  if (raises) await expect(key(page, "Hide keyboard")).toBeVisible();
  return terminal;
}

/**
 * The terminal once a keyboard change has reached its grid. wterm fits the visual viewport on one animation frame and
 * draws the new rows after that frame, so a read right after a keyboard key still sees the grid from before it; a spec
 * that measures it there reads a view the page no longer has. Waits for the rendered grid to be the size the core
 * holds, which is both the view the spec then works in and the point past the frame that scrolled it to the bottom.
 */
export async function settledGrid(page: Page, terminal: Locator): Promise<void> {
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  if (address === "") throw new Error("the phone's terminal has no address");
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await expect
    .poll(
      async () => {
        const shown = await gridSize(terminal);
        const core = coreSize(address);
        return shown === core ? null : `the grid shows ${shown}, the core holds ${core}`;
      },
      { timeout: 10_000 },
    )
    .toBeNull();
}

export const keysBar = (page: Page) => page.getByRole("toolbar", { name: "Terminal keys" });
/** The Chat composer, which takes the keys' place while a line is written (#2604). */
export const chatComposer = (page: Page) => page.getByRole("group", { name: "Chat" });
/** Opens the Chat composer from the keys and returns its field, focused. */
export async function openChat(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const field = chatComposer(page).getByLabel("Type into the terminal");
  await expect(field).toBeFocused();
  return field;
}
export const key = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

/**
 * Holds the keys bar's Ctrl until the Shortcut packs sheet opens, as a finger does: a held Ctrl opens the packs panel
 * (KeyButton's hold), and the lift that follows sends nothing. Resolves once the sheet is on screen.
 */
export async function openShortcutPacks(page: Page): Promise<void> {
  const ctrl = keysBar(page).getByRole("button", { name: "Control", exact: true });
  const box = await ctrl.boundingBox();
  if (box === null) throw new Error("the keys bar's Ctrl is not laid out");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const sheet = page.getByRole("dialog", { name: "Shortcut packs" });
  await expect(sheet).toBeVisible();
  await page.mouse.up();
}

export async function expectTouchTargets(scope: Locator): Promise<void> {
  const small = await scope.getByRole("button").evaluateAll((buttons) =>
    buttons
      .map((button) => ({ name: button.getAttribute("aria-label") ?? "", box: button.getBoundingClientRect() }))
      .filter(({ box }) => box.width < 44 || box.height < 44)
      .map(({ name, box }) => `${name} ${Math.round(box.width)}x${Math.round(box.height)}`),
  );
  expect(small).toEqual([]);
}
