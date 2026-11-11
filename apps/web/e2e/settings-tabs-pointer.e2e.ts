import { expect, test } from "./fixtures.ts";

// A narrow window under a mouse still draws the Settings tab strip (below md); there a paging cue keeps its 32 px slot,
// since the 44 px tap width is for a touch screen only (#892).
test.use({ viewport: { width: 600, height: 800 }, hasTouch: false, isMobile: false, serviceWorkers: "block" });

test("a paging cue keeps its 32 px slot with a mouse, at rest and paged to the end (#892)", async ({ page: tab }) => {
  await tab.goto("/settings");
  const cues = () =>
    tab
      .locator("[data-tab-edge]")
      .evaluateAll((all) =>
        all.map((cue) => `${cue.getAttribute("data-tab-edge") ?? ""} ${Math.round(cue.getBoundingClientRect().width)}`),
      );
  // Each read waits for the strip to reach that state first. A cue pages with a smooth scroll, and the end cue goes once
  // the scroll reaches the end; evaluateAll finds the cues and measures them in two calls, so a read during the scroll
  // could measure an end cue already taken out of the page, at 0 px (#2045). The strip names its state in the same render
  // that draws the cues, and nothing moves once it reads "start".
  const strip = tab.locator("[data-tab-overflow]");
  await expect(strip).toHaveAttribute("data-tab-overflow", "end");
  expect(await cues()).toEqual(["end 32"]);
  await tab.locator('[data-tab-edge="end"]').click();
  await expect(strip).toHaveAttribute("data-tab-overflow", "start");
  expect(await cues()).toEqual(["start 32"]);
});
