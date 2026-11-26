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
  /** The furthest any element in it is scrolled down, in px. */
  readonly scrolled: number;
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
                      .toSorted()
                      .join(","),
              duration: Number(motion.effect?.getComputedTiming().duration ?? 0),
            }));
            const scrolled = Math.max(
              0,
              ...[found, ...found.querySelectorAll("*")].map((element) => element.scrollTop),
            );
            resolve({ motions, opacity: getComputedStyle(found).opacity, scrolled });
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

interface Ride {
  readonly what: string;
  readonly duration: number;
  /** How far below its new place the ride starts, in px (its first keyframe's translateY). */
  readonly from: number;
}

/** The motion the keys panel plays as it next moves (docking or riding), seen as the move's attribute change lands. */
const rideMotion = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<readonly Ride[]>((resolve) => {
        const panel = document.querySelector('[role="toolbar"][aria-label="Terminal keys"]')?.parentElement;
        if (!(panel instanceof HTMLElement)) throw new Error("no keys panel");
        new MutationObserver((_records, observer) => {
          observer.disconnect();
          resolve(
            panel.getAnimations().map((motion) => {
              const first = (motion.effect as KeyframeEffect).getKeyframes()[0];
              return {
                what: Object.keys(first ?? {})
                  .filter((key) => !["offset", "easing", "composite", "computedOffset"].includes(key))
                  .join(","),
                duration: Number(motion.effect?.getComputedTiming().duration ?? 0),
                from: new DOMMatrixReadOnly(String(first?.["transform"] ?? "none")).m42,
              };
            }),
          );
        }).observe(panel, { attributes: true });
      }),
  );

/** The keys panel's bottom edge where it is laid out, once no motion moves it. */
const restingBottom = (page: Page) =>
  page.evaluate(async () => {
    const panel = document.querySelector('[role="toolbar"][aria-label="Terminal keys"]')?.parentElement;
    if (!(panel instanceof HTMLElement)) throw new Error("no keys panel");
    await Promise.all(panel.getAnimations().map((motion) => motion.finished));
    return panel.getBoundingClientRect().bottom;
  });

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

  test("under reduced motion the drawer cross-fades in and goes at once", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await ready(page);
    const opening = inserted(page, "[data-sidebar-drawer]");
    await page.getByRole("button", { name: "Show sidebar" }).click();
    expect((await opening).motions.map((motion) => motion.what)).toEqual(["opacity"]);
    await expect(page.locator("[data-sidebar-drawer]")).toBeVisible();

    await page.evaluate(() => {
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes)
            if (node instanceof HTMLElement && node.hasAttribute("data-leaving")) Reflect.set(window, "__left", true);
      }).observe(document.body, { childList: true });
    });
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-sidebar-drawer]")).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, "__left") === true)).toBe(false);
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

  test("Settings scrolled partway leaves showing what was on screen, not its top", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    await page.getByRole("link", { name: "Settings" }).click();
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Keybindings" }).click();
    const body = page.locator('[data-settings-dialog] [data-slot="settings-body"]');
    const top = await body.evaluate((viewport) => {
      viewport.scrollTop = 400;
      return viewport.scrollTop;
    });
    expect(top).toBeGreaterThan(0);

    const closing = inserted(page, "[data-leaving]:has(*)");
    await page.keyboard.press("Escape");
    expect((await closing).scrolled).toBe(top);
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
    const ride = rideMotion(page);
    await page.getByRole("button", { name: "Show keyboard" }).click();
    expect((await ride).map(({ what, duration }) => ({ what, duration }))).toEqual([
      { what: "transform", duration: 240 },
    ]);
  });

  test("the keys panel rides down to its dock as the keyboard goes", async ({ page }) => {
    await openPhoneTerminal(page);
    await expect(page.getByRole("button", { name: "Hide keyboard" })).toBeVisible();
    const ride = rideMotion(page);
    await page.getByRole("button", { name: "Hide keyboard" }).click();
    const [down] = await ride;
    expect(down?.what).toBe("transform");
    expect(down?.duration).toBe(240);
    expect(down?.from).toBeLessThan(0);
  });

  test("after the window resizes, the next ride starts where the panel stands", async ({ page }) => {
    await openPhoneTerminal(page);
    await showKeyboard(page, 0);
    await expect(page.getByRole("button", { name: "Show keyboard" })).toBeVisible();
    // Shorter by less than any keyboard, as a browser's toolbar or a rotation makes it: the panel moves without a ride.
    await page.setViewportSize({ width: 390, height: 724 });
    await expect.poll(() => restingBottom(page)).toBeLessThan(724);
    const before = await restingBottom(page);

    const ride = rideMotion(page);
    await page.getByRole("button", { name: "Show keyboard" }).click();
    const [up] = await ride;
    const after = await restingBottom(page);
    expect(up?.what).toBe("transform");
    expect(Math.abs((up?.from ?? 0) - (before - after))).toBeLessThanOrEqual(1);
  });

  test("under reduced motion the keys panel takes its place at once", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openPhoneTerminal(page);
    await showKeyboard(page, 0);
    await expect(page.getByRole("button", { name: "Show keyboard" })).toBeVisible();
    const ride = rideMotion(page);
    await page.getByRole("button", { name: "Show keyboard" }).click();
    expect(await ride).toEqual([]);
  });
});
