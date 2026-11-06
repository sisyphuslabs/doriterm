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
  const end = tab.locator('[data-tab-edge="end"]');
  await expect(end).toHaveCount(1);
  expect(await cues()).toEqual(["end 32"]);
  await end.click();
  await expect(tab.locator('[data-tab-edge="start"]')).toHaveCount(1);
  expect((await cues()).every((cue) => cue.endsWith(" 32"))).toBe(true);
});
