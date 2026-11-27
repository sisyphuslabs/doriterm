// Pinned tabs and the strip's overflow (review of #2865): pinned tabs keep their whole width while the strip has room,
// whatever the number of other tabs; once pinned and other tabs no longer fit, the other tabs give way first and All tabs
// appears, and a strip of only pinned tabs scrolls too, so every tab stays reachable and New tab and the pane actions
// stay in the bar. At 820 with a finger (the tablet's rail and Split pane menu) and at 1440 with a mouse.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { fold } from "./fold.ts";
import { seedSpaces } from "./layout-doc.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { strip, tabs } from "./tab-strip.ts";

endOwnTerminals();

const TAG = "tpo-" + Date.now().toString(36);

/** A control lies wholly inside the top bar and nothing is drawn over its centre, so it can be reached. */
async function expectInBar(page: Page, control: Locator): Promise<void> {
  const bar = page.locator("[data-titlebar]:has([role=tablist])");
  const [box, barBox] = [await control.boundingBox(), await bar.boundingBox()];
  if (box === null || barBox === null) throw new Error("control or bar not laid out");
  expect(box.x).toBeGreaterThanOrEqual(barBox.x);
  expect(box.x + box.width).toBeLessThanOrEqual(barBox.x + barBox.width);
  const onTop = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
  expect(onTop).toBe(true);
}

/** Whether a tab group hides any of its tabs: scrolled, clipped, or marked with an edge fade. */
const hides = (group: Locator) =>
  group.evaluate(
    (el) =>
      el.scrollLeft > 0 ||
      el.scrollWidth > el.clientWidth ||
      el.hasAttribute("data-overflow-start") ||
      el.hasAttribute("data-overflow-end"),
  );

// "crowd" is the number of pinned tabs (icons, about 33 px each) past the width the surface's strip has for them.
const shapes = (crowd: number) =>
  [
    { pinned: 1, others: 0, crowded: false },
    { pinned: 3, others: 0, crowded: false },
    { pinned: 3, others: 2, crowded: false },
    { pinned: crowd, others: 1, crowded: true },
    { pinned: crowd, others: 0, crowded: true },
  ] as const;

const SURFACES = [
  { name: "820 with a finger", touch: true, size: { width: 820, height: 1180 }, split: "Split pane", crowd: 24 },
  { name: "1440 with a mouse", touch: false, size: { width: 1440, height: 900 }, split: "Split right", crowd: 48 },
] as const;

for (const surface of SURFACES) {
  test.describe(surface.name, () => {
    test.use({ serviceWorkers: "block", hasTouch: surface.touch, isMobile: surface.touch });

    for (const shape of shapes(surface.crowd)) {
      const outcome = shape.crowded ? "All tabs reaches every tab" : "every tab whole, no All tabs";
      test(`${shape.pinned} pinned and ${shape.others} other tabs: ${outcome}`, async ({ page }) => {
        const count = shape.pinned + shape.others;
        const key = `${surface.touch ? "t" : "m"}${shape.pinned}-${shape.others}`;
        seedSpaces([
          {
            id: `spc-${TAG}-${key}`,
            name: "pins",
            folder: mkdtempSync(join(tmpdir(), "tpo-")),
            tabs: Array.from({ length: count }, (_unused, at) => ({
              id: `tb-${TAG}-${key}-${at}`,
              name: `p${at}`,
              terminal: startShell("host", `${TAG}-${key}-${at}`),
              pinned: at < shape.pinned,
            })),
          },
        ]);
        if (surface.touch) await fold(page, surface.size);
        else await page.setViewportSize(surface.size);
        await page.goto("/");
        await expect(tabs(page)).toHaveCount(count, { timeout: 20_000 });
        await expectInBar(page, page.getByRole("button", { name: "New tab", exact: true }));
        await expectInBar(page, page.getByRole("button", { name: surface.split, exact: true }));

        const allTabs = page.getByRole("button", { name: "All tabs", exact: true });
        if (!shape.crowded) {
          await expect(tabs(page).last()).toBeVisible();
          expect(await hides(strip(page).locator("[data-tab-pins]"))).toBe(false);
          await expect(allTabs).toHaveCount(0);
          return;
        }
        await expect(allTabs).toBeVisible({ timeout: 10_000 });
        await expectInBar(page, allTabs);
        await allTabs.click();
        const items = page.getByRole("menu").getByRole("menuitem");
        await expect(items).toHaveCount(count);
        await items.nth(count - 1).click();
        await expect(tabs(page).nth(count - 1)).toHaveAttribute("aria-selected", "true");
      });
    }
  });
}
