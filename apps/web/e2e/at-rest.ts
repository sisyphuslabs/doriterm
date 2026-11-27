import type { Page } from "@playwright/test";

/**
 * Waits until nothing on the page is moving: two frames (so a commit a resize or a click scheduled has drawn, and any
 * motion it started is running), then every finite animation and transition to its end, again until a pass finds none.
 * Endless ones (a spinner, a pulse) are not waited on. The app moves panels, sheets, Settings and the keys on the motion
 * tokens (DESIGN.md 6, #2875), so a box read mid-motion is not where the thing settles. It counts frames, so it is not
 * for a page whose clock a spec has paused (page.clock).
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
