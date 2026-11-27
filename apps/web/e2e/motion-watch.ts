import type { Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

// What the motion specs watch (#2875): the motion an element plays as it is inserted, and the keys panel's ride.

export interface Seen {
  /** CSS transitions and script animations running on the element as it was inserted, by property or keyframe. */
  readonly motions: readonly { readonly what: string; readonly duration: number }[];
  readonly opacity: string;
  /** The furthest any element in it is scrolled down, in px. */
  readonly scrolled: number;
}

/**
 * Watches for the first element matching `selector` that the page inserts from now on, and returns the call that gives
 * its motion as the insertion's mutation was observed, before any frame of it was drawn. The watch is in place when this
 * resolves, so the action that inserts the element comes after it however slow the page is.
 */
export async function inserted(page: Page, selector: string): Promise<() => Promise<Seen>> {
  const watch = await page.evaluateHandle(
    (sought) => ({
      seen: new Promise<Seen>((resolve) => {
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
                      .filter((property) => !["offset", "easing", "composite", "computedOffset"].includes(property))
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
    }),
    selector,
  );
  return () => watch.evaluate((armed) => armed.seen);
}

export const ready = async (page: Page): Promise<void> => {
  await expect(page.locator(":root[data-ready]")).toHaveCount(1, { timeout: 20_000 });
};

export interface Ride {
  readonly what: string;
  readonly duration: number;
  /** How far below its new place the ride starts, in px (its first keyframe's translateY). */
  readonly from: number;
}

/**
 * Watches the keys panel from now on, and returns the call that gives the motion it plays as it next moves (docking or
 * riding), seen as the move's attribute change lands.
 */
export async function rideMotion(page: Page): Promise<() => Promise<readonly Ride[]>> {
  const watch = await page.evaluateHandle(() => ({
    rides: new Promise<readonly Ride[]>((resolve) => {
      const panel = document.querySelector('[role="toolbar"][aria-label="Terminal keys"]')?.parentElement;
      if (!(panel instanceof HTMLElement)) throw new Error("no keys panel");
      new MutationObserver((_records, observer) => {
        observer.disconnect();
        resolve(
          panel.getAnimations().map((motion) => {
            const first = (motion.effect as KeyframeEffect).getKeyframes()[0];
            return {
              what: Object.keys(first ?? {})
                .filter((property) => !["offset", "easing", "composite", "computedOffset"].includes(property))
                .join(","),
              duration: Number(motion.effect?.getComputedTiming().duration ?? 0),
              from: new DOMMatrixReadOnly(String(first?.["transform"] ?? "none")).m42,
            };
          }),
        );
      }).observe(panel, { attributes: true });
    }),
  }));
  return () => watch.evaluate((armed) => armed.rides);
}

/** The keys panel's bottom edge where it is laid out, once no motion moves it. */
export const restingBottom = (page: Page) =>
  page.evaluate(async () => {
    const panel = document.querySelector('[role="toolbar"][aria-label="Terminal keys"]')?.parentElement;
    if (!(panel instanceof HTMLElement)) throw new Error("no keys panel");
    await Promise.all(panel.getAnimations().map((motion) => motion.finished));
    return panel.getBoundingClientRect().bottom;
  });
