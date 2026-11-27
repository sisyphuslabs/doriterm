import { expect, opened, test } from "./fixtures.ts";

// Long enough that the sheet is still opening whenever it is taken off the page.
const SHEET = `<style>
  [role="dialog"] { transition: transform 30s; transform: none; }
  @starting-style { [role="dialog"] { transform: translateY(100%); } }
</style><div role="dialog" aria-label="Sheet">sheet</div>`;

// The phone drops a sheet whose screen is replaced while it opens (a new tab's screen, keyed by session): here the sheet
// is taken off the page right after opened() collects its running motion.
test("opened() fails at once, by name, when the sheet leaves the page before it comes to rest", async ({ page }) => {
  await page.setContent(SHEET);
  await page.evaluate(async () => {
    const sheet = document.querySelector('[role="dialog"]');
    await Promise.all((sheet?.getAnimations() ?? []).map((motion) => motion.ready));
    const collect = Element.prototype.getAnimations;
    Element.prototype.getAnimations = function (this: Element, options?: GetAnimationsOptions) {
      Element.prototype.getAnimations = collect;
      queueMicrotask(() => sheet?.remove());
      return collect.call(this, options);
    };
  });
  await expect(opened(page.getByRole("dialog"))).rejects.toThrow("left the page before it came to rest");
});
