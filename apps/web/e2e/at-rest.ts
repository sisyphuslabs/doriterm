import type { Locator, Page } from "@playwright/test";

/**
 * Waits until nothing on the page is moving: two frames (so a commit a resize or a click scheduled has drawn, and any
 * motion it started is running), then every finite animation and transition to its end, again until a pass finds none.
 * Endless ones (a spinner, a pulse) are not waited on. The app moves panels, sheets, Settings and the keys on the motion
 * tokens (DESIGN.md 6, #2875), so a box read mid-motion is not where the thing settles.
 */
export async function atRest(page: Page): Promise<void> {
  await page.evaluate(() => {
    const settle = async (): Promise<void> => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const moving = document
        .getAnimations()
        .filter(
          (motion) =>
            motion.playState === "running" && Number.isFinite(motion.effect?.getComputedTiming().endTime ?? Infinity),
        );
      if (moving.length === 0) return;
      await Promise.all(moving.map((motion) => motion.finished.catch(() => undefined)));
      await settle();
    };
    return settle();
  });
}

let installed = false;

/**
 * Makes every `boundingBox()` read the box at rest (`atRest` first), so no spec measures a surface mid-motion. A spec
 * that means to see motion reads its animations in the page instead (panel-motion.e2e.ts, motion.e2e.ts).
 */
export function readBoxesAtRest(page: Page): void {
  if (installed) return;
  installed = true;
  const prototype: Locator = Object.getPrototypeOf(page.locator("html"));
  const read = prototype.boundingBox;
  prototype.boundingBox = async function boundingBoxAtRest(this: Locator, options) {
    await atRest(this.page());
    return await read.call(this, options);
  };
}
