import { expect, openNewTerminal, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

// An idle terminal must cost its renderer nothing per frame: a CSS animation on the cursor makes Chromium recalculate
// style and paint on every frame (60 a second) even though a blink changes only twice a second. The focused cursor
// still blinks, by an attribute flipped every half second.
test("an idle focused terminal runs no CSS animation, and its cursor still blinks", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  const focused = page.locator(".wterm.focused");
  await expect(focused).toHaveCount(1);
  const seen = await focused.evaluate(
    (element) =>
      new Promise<{ flips: number; animations: string[] }>((resolve) => {
        let flips = 0;
        const flipped = new MutationObserver(() => flips++);
        flipped.observe(element, { attributes: true, attributeFilter: ["data-cursor-off"] });
        // The blink's own period is what is measured here: a second and a half spans three of its half-second phases.
        setTimeout(() => {
          flipped.disconnect();
          const running = document.getAnimations().filter((animation) => animation.playState === "running");
          resolve({ flips, animations: running.map((animation) => (animation as CSSAnimation).animationName) });
        }, 1500);
      }),
  );
  expect(seen.animations).toEqual([]);
  expect(seen.flips).toBeGreaterThanOrEqual(2);
});
