import type { Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });
// Headless Chromium hides scrollbars; without that flag it draws classic ones with a gutter, as Electron on Linux does.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

interface Overflow {
  readonly x: number;
  readonly y: number;
  readonly gutterX: number;
  readonly gutterY: number;
  readonly overflowX: string;
  readonly overflowY: string;
}

/** How far the element's content passes its box on each axis, and the width/height a native scrollbar takes from it. */
const overflowOf = (page: Page, selector: string): Promise<Overflow | null> =>
  page.evaluate((target) => {
    const element = document.querySelector<HTMLElement>(target);
    if (element === null) return null;
    const style = getComputedStyle(element);
    return {
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      x: element.scrollWidth - element.clientWidth,
      y: element.scrollHeight - element.clientHeight,
      gutterY:
        element.offsetWidth -
        element.clientWidth -
        Number.parseFloat(style.borderLeftWidth) -
        Number.parseFloat(style.borderRightWidth),
      gutterX:
        element.offsetHeight -
        element.clientHeight -
        Number.parseFloat(style.borderTopWidth) -
        Number.parseFloat(style.borderBottomWidth),
    };
  }, selector);

/** Fits, scrolls only along its one axis, and never reserves a scrollbar on either (`scroll` draws one even with nothing to scroll). */
const fitsScrolling = (axis: "x" | "y"): Overflow => ({
  x: 0,
  y: 0,
  gutterX: 0,
  gutterY: 0,
  overflowX: axis === "x" ? "auto" : "hidden",
  overflowY: axis === "y" ? "auto" : "hidden",
});

test("with classic scrollbars, the sidebar list and the tab strip draw none while their content fits (#343)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  // macOS draws overlay scrollbars even so; a styled webkit scrollbar is classic on every platform. It applies only where
  // scrollbar-width and scrollbar-color are auto, so the base layer's `*` rule for them is undone in that same layer, after it:
  // an element's own scrollbar-width (a utility, a later layer) still wins, as it does in the app.
  await page.addStyleTag({
    content:
      "@layer base { * { scrollbar-width: auto; scrollbar-color: auto; } } ::-webkit-scrollbar { width: 10px; height: 10px; background: gray; }",
  });
  await openNewTerminal(page);
  // The probe proves this browser draws classic scrollbars at all, so a zero below is not the headless overlay.
  const probe = await page.evaluate(() => {
    const box = document.createElement("div");
    box.style.cssText = "position:absolute;width:100px;height:100px;overflow:scroll";
    document.body.append(box);
    const gutter = box.offsetWidth - box.clientWidth;
    box.remove();
    return gutter;
  });
  expect(probe).toBeGreaterThan(0);

  await expect.poll(() => overflowOf(page, '[data-slot="agents-list"]')).toEqual(fitsScrolling("y"));
  await expect
    .poll(() => overflowOf(page, '[role="tablist"][aria-label="Tabs"] [data-tab-scroll]'))
    .toEqual(fitsScrolling("x"));
});
