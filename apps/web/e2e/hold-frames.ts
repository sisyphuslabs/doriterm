import type { Page } from "@playwright/test";

/**
 * Holds the page's animation frames, as a page too busy to draw holds them, until the returned release runs every one
 * still wanted. Anything the page puts off to its next frame waits; what it does at once does not.
 */
export async function holdFrames(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const held = new Map<number, FrameRequestCallback>();
    let next = -1;
    window.requestAnimationFrame = (callback) => (held.set(next, callback), next--);
    window.cancelAnimationFrame = (id) => void (held.delete(id) || cancel(id));
    Reflect.set(window, "__releaseFrames", () => {
      window.requestAnimationFrame = request;
      window.cancelAnimationFrame = cancel;
      for (const callback of held.values()) request(callback);
      held.clear();
    });
  });
  return () => page.evaluate(() => Reflect.get(window, "__releaseFrames")());
}
