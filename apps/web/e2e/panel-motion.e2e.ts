import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { openPhoneTerminal, PHONE, showKeyboard } from "./phone-key-bar.ts";

// The redesign's second motion pass (#2875): panels and screens that came and went in one frame now move on the #2796
// tokens, and leave as an inert picture that plays its exit (the mechanism Back uses).

test.use({ serviceWorkers: "block" });

interface Seen {
  /** CSS transitions and script animations running on the element as it was inserted, by property or keyframe. */
  readonly motions: readonly { readonly what: string; readonly duration: number }[];
  readonly opacity: string;
}

/**
 * Resolves with the motion of the first element matching `selector` that the page inserts after this call: as the
 * insertion's mutation is observed, before any frame of its motion is drawn.
 */
function inserted(page: Page, selector: string): Promise<Seen> {
  return page.evaluate(
    (sought) =>
      new Promise<Seen>((resolve) => {
        new MutationObserver((records, observer) => {
          for (const node of records.flatMap((record) => [...record.addedNodes])) {
            if (!(node instanceof HTMLElement)) continue;
            const found = node.matches(sought) ? node : node.querySelector<HTMLElement>(sought);
            if (found === null) continue;
            observer.disconnect();
            const motions = found.getAnimations().map((motion) => ({
              what:
                motion instanceof CSSTransition
                  ? motion.transitionProperty
                  : Object.keys((motion.effect as KeyframeEffect).getKeyframes()[0] ?? {})
                      .filter((key) => !["offset", "easing", "composite", "computedOffset"].includes(key))
                      .join(","),
              duration: Number(motion.effect?.getComputedTiming().duration ?? 0),
            }));
            resolve({ motions, opacity: getComputedStyle(found).opacity });
            return;
          }
        }).observe(document.body, { childList: true, subtree: true });
      }),
    selector,
  );
}

const ready = async (page: Page): Promise<void> => {
  await expect(page.locator(":root[data-ready]")).toHaveCount(1, { timeout: 20_000 });
};

/** The motion the keys panel plays when the keyboard next comes up, as the panel moves to ride on it. */
const rideMotion = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<readonly { readonly what: string; readonly duration: number }[]>((resolve) => {
        const panel = document.querySelector('[role="toolbar"][aria-label="Terminal keys"]')?.parentElement;
        if (!(panel instanceof HTMLElement)) throw new Error("no keys panel");
        new MutationObserver((_records, observer) => {
          observer.disconnect();
          resolve(
            panel.getAnimations().map((motion) => ({
              what: Object.keys((motion.effect as KeyframeEffect).getKeyframes()[0] ?? {})
                .filter((key) => !["offset", "easing", "composite", "computedOffset"].includes(key))
                .join(","),
              duration: Number(motion.effect?.getComputedTiming().duration ?? 0),
            })),
          );
        }).observe(panel, { attributes: true });
        (Reflect.get(window, "softKeyboard") as (px: number) => void)(336);
      }),
  );

test.describe("an iPad in portrait (medium)", () => {
  test.use({ viewport: { width: 820, height: 1180 } });

  test("the sidebar drawer slides in with its scrim fading, and slides out as a picture", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    const opening = inserted(page, "[data-sidebar-drawer]");
    await page.getByRole("button", { name: "Show sidebar" }).click();
    expect((await opening).motions).toContainEqual({ what: "transform", duration: 320 });
    await expect(page.locator("[data-sidebar-drawer]")).toBeVisible();

    const closing = inserted(page, "[data-leaving]:has(*)");
    await page.keyboard.press("Escape");
    const picture = await closing;
    expect(picture.motions).toEqual([{ what: "transform", duration: 200 }]);
    expect(picture.opacity).toBe("1");
    await expect(page.locator("[data-sidebar-drawer]")).toHaveCount(0);
    await expect(page.locator("[data-leaving]")).toHaveCount(0);
  });

  test("under reduced motion the drawer cross-fades: no travel in or out", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await ready(page);
    const opening = inserted(page, "[data-sidebar-drawer]");
    await page.getByRole("button", { name: "Show sidebar" }).click();
    expect((await opening).motions.map((motion) => motion.what)).toEqual(["opacity"]);
    await expect(page.locator("[data-sidebar-drawer]")).toBeVisible();

    const closing = inserted(page, "[data-leaving]:has(*)");
    await page.keyboard.press("Escape");
    expect((await closing).motions).toEqual([{ what: "opacity", duration: 200 }]);
    await expect(page.locator("[data-sidebar-drawer]")).toHaveCount(0);
  });
});

test.describe("a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Settings' dialog scale-fades in and fades out as a picture", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    const opening = inserted(page, "[data-settings-dialog]");
    await page.getByRole("link", { name: "Settings" }).click();
    const dialog = await opening;
    expect(dialog.motions).toContainEqual({ what: "transform", duration: 220 });
    expect(dialog.motions).toContainEqual({ what: "opacity", duration: 220 });

    const closing = inserted(page, "[data-leaving]:has(*)");
    await page.keyboard.press("Escape");
    expect((await closing).motions).toEqual([{ what: "opacity,transform", duration: 200 }]);
    await expect(page.locator("[data-leaving]")).toHaveCount(0);
  });
});

test.describe("a touch phone", () => {
  test.use(PHONE);

  endOwnTerminals();

  test("Settings is pushed in from the trailing edge and slides off as Back does", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
    await ready(page);
    const opening = inserted(page, "[data-settings-sheet]");
    await page.getByRole("link", { name: "Settings" }).click();
    expect((await opening).motions).toContainEqual({ what: "transform", duration: 320 });

    const closing = inserted(page, "[data-leaving]");
    await page.keyboard.press("Escape");
    const picture = await closing;
    expect(picture.motions).toEqual([{ what: "transform", duration: 200 }]);
    expect(picture.opacity).toBe("1");
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    await expect(page.locator("[data-leaving]")).toHaveCount(0);
  });

  test("Back's picture of the terminal starts as it was drawn, not from its own arrival", async ({ page }) => {
    await openPhoneTerminal(page);
    const closing = inserted(page, "[data-leaving]");
    await page.getByRole("button", { name: "Back to agents" }).click();
    const picture = await closing;
    expect(picture.opacity).toBe("1");
    expect(picture.motions).toEqual([{ what: "transform", duration: 200 }]);
  });

  test("the keys panel rides up with the keyboard by a transform (#2539)", async ({ page }) => {
    await openPhoneTerminal(page);
    await showKeyboard(page, 0);
    await expect(page.getByRole("button", { name: "Show keyboard" })).toBeVisible();
    expect(await rideMotion(page)).toEqual([{ what: "transform", duration: 240 }]);
  });

  test("under reduced motion the keys panel takes its place at once", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openPhoneTerminal(page);
    await showKeyboard(page, 0);
    await expect(page.getByRole("button", { name: "Show keyboard" })).toBeVisible();
    expect(await rideMotion(page)).toEqual([]);
  });
});
