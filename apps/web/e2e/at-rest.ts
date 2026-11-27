import type { Page } from "@playwright/test";

/**
 * Runs in the page (Locator.evaluateAll, which waits for nothing): waits until nothing in `roots` is moving, and says
 * whether there was a root and every one is still on the page. Each pass waits two frames (so a commit a resize or a
 * click scheduled has drawn, and any motion it started is running), then every finite animation and transition in them
 * to its end, finished or cancelled (a cancel rejects `finished`), until a pass finds none. Endless ones (a spinner, a
 * pulse) are not waited on.
 */
export async function settled(roots: readonly Element[]): Promise<boolean> {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each pass waits for the frames the last one's motion drew
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const moving = roots
      .flatMap((root) => root.getAnimations({ subtree: true }))
      .filter(
        (motion) =>
          motion.playState === "running" && Number.isFinite(motion.effect?.getComputedTiming().endTime ?? Infinity),
      );
    if (moving.length === 0) return roots.length > 0 && roots.every((root) => root.isConnected);
    // oxlint-disable-next-line no-await-in-loop -- a motion that ends can start the next one
    await Promise.all(moving.map((motion) => motion.finished.catch(() => undefined)));
  }
}

/**
 * Waits until nothing on the page is moving (settled). The app moves panels, sheets, Settings and the keys on the motion
 * tokens (DESIGN.md 6, #2875), so a box read mid-motion is not where the thing settles. It counts frames, so it is not
 * for a page whose clock a spec has paused (page.clock).
 */
export async function atRest(page: Page): Promise<void> {
  await page.locator(":root").evaluateAll(settled);
}
