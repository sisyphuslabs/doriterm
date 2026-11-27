// The section-rhythm gate itself (#1496, #2866): a heading that is the first text of its own <section> is measured against
// that section's first line, wherever the line starts, and the 1.5 x threshold still fails a heading that floats midway.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { sectionRhythm } from "./section-rhythm.ts";

/** A sidebar-like page: a short title on the rows' edge, then rows whose label starts 26 px further right. */
const sidebar = (gapAbove: number, gapBelow: number): string => `
  <aside style="width:240px;font:12px/16px system-ui">
    <section style="display:flex;flex-direction:column">
      <h2 style="margin:0;padding-left:8px">Working</h2>
      <div style="margin-top:9px;padding-left:34px">review</div>
    </section>
    <section style="display:flex;flex-direction:column;margin-top:${gapAbove}px">
      <h2 style="margin:0;padding-left:8px;width:22px">Idle</h2>
      <div style="margin-top:${gapBelow}px;padding-left:34px">shell</div>
    </section>
  </aside>`;

async function idleHeading(page: Page, html: string) {
  await page.setContent(`<body style="margin:8px">${html}</body>`);
  const rhythm = await page.evaluate(sectionRhythm);
  const heading = rhythm.headings.find((h) => h.name === "Idle");
  if (heading === undefined) throw new Error("the Idle heading was not measured");
  return heading;
}

test("a short title on its rows' edge is measured against its own first row and passes at 24 above, 9 below", async ({
  page,
}) => {
  const heading = await idleHeading(page, sidebar(24, 9));
  // Paired with its own row: the gap it was given, give or take the font's line metrics.
  expect(Math.abs(heading.below - 9)).toBeLessThanOrEqual(2);
  expect(heading.above / heading.below).toBeGreaterThanOrEqual(1.5);
});

test("the section rule still fails a heading as far from its own first row as from the section above (60 / 60)", async ({
  page,
}) => {
  const heading = await idleHeading(page, sidebar(60, 60));
  expect(Math.abs(heading.below - 60)).toBeLessThanOrEqual(2);
  expect(heading.above / heading.below).toBeLessThan(1.5);
});
