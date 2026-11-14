// Every control a finger has to hit on the phone takes a tap anywhere in the 44x44 box centred on it (#1030): Apple's
// Human Interface Guidelines put the touch minimum at 44x44 pt. A control may draw smaller (a 24 px "..." or a 36x20
// switch); its hit area is what has to reach 44.
import { devices, type Page } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

/** Apple HIG's minimum touch target, in CSS px (one pt each). */
const TARGET = 44;

/**
 * Every control on screen whose box is under the target in either direction, with each point of the target box centred
 * on it that a tap does not reach it from: `<name> <w>x<h> misses <corner or edge>:<what the tap hit>`. A point is held
 * just inside the box's edge so sub-pixel rounding cannot decide it, and a point off the screen cannot be tapped at all.
 */
const shortTargets = (page: Page): Promise<readonly string[]> =>
  page.evaluate((target) => {
    const controls = document.querySelectorAll<HTMLElement>(
      'button, a[href], input:not([type="hidden"]), select, textarea, [role="switch"], [role="tab"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="slider"]',
    );
    const reach = target / 2 - 0.5;
    const offsets = [
      [-reach, -reach],
      [0, -reach],
      [reach, -reach],
      [-reach, 0],
      [reach, 0],
      [-reach, reach],
      [0, reach],
      [reach, reach],
    ] as const;
    const found: string[] = [];
    for (const control of controls) {
      const box = control.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || (box.width >= target && box.height >= target)) continue;
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      // A control nothing can tap (hidden, or under another layer) is not a target on this screen.
      const centre = document.elementFromPoint(x, y);
      if (centre === null || !control.contains(centre)) continue;
      const misses = offsets.flatMap(([dx, dy]) => {
        const at = { x: x + dx, y: y + dy };
        if (at.x < 0 || at.y < 0 || at.x >= innerWidth || at.y >= innerHeight) return [];
        const hit = document.elementFromPoint(at.x, at.y);
        if (hit !== null && control.contains(hit)) return [];
        const where = `${"-0+".charAt(Math.sign(dx) + 1)}${"-0+".charAt(Math.sign(dy) + 1)}`;
        return [`${where}:${hit?.getAttribute("aria-label") ?? hit?.tagName.toLowerCase() ?? "none"}`];
      });
      if (misses.length > 0) {
        const label = control.getAttribute("aria-label") ?? control.textContent?.trim().slice(0, 40);
        found.push(`${label} ${Math.round(box.width)}x${Math.round(box.height)} misses ${misses.join(" ")}`);
      }
    }
    return found;
  }, TARGET);

test("on the phone every agent row's More, New space and fold button takes a tap anywhere in its 44x44 box", async ({
  page,
}) => {
  const agents = ["deploy", "review", "plan"].map((name) => startAgent("host", name, "idle"));
  try {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "More for plan" })).toBeVisible({ timeout: 20_000 });
    expect(await shortTargets(page)).toEqual([]);
  } finally {
    for (const address of agents) endAgent("host", address);
  }
});

test("on the phone every Settings switch takes a tap anywhere in its 44x44 box, on every section", async ({ page }) => {
  await page.goto("/settings");
  const tabs = page.getByRole("tablist").getByRole("tab");
  await expect(tabs.first()).toBeVisible({ timeout: 20_000 });
  const body = page.locator("[data-slot=settings-body]");
  // On a phone the page scrolls Settings, not the sections' body (#2533): each section is stepped through the document.
  const found: string[] = [];
  let switches = 0;
  for (const label of await tabs.allTextContents()) {
    // oxlint-disable-next-line no-await-in-loop -- one section at a time: each tap changes the page the next one reads
    await tabs.filter({ hasText: label }).first().click();
    // oxlint-disable-next-line no-await-in-loop -- as above
    await expect(page.getByRole("heading", { name: label, level: 2 }).first()).toBeVisible();
    // oxlint-disable-next-line no-await-in-loop -- as above
    const { height, view } = await page.evaluate(() => {
      const scroller = document.scrollingElement ?? document.documentElement;
      return { height: scroller.scrollHeight, view: scroller.clientHeight };
    });
    for (let top = 0; top < height; top += Math.max(1, Math.floor(view * 0.75))) {
      // oxlint-disable-next-line no-await-in-loop -- each scroll position is read after the last one settles
      await page.evaluate((to) => window.scrollTo({ top: to, behavior: "instant" }), top);
      // oxlint-disable-next-line no-await-in-loop -- as above
      found.push(...(await shortTargets(page)).map((entry) => `${label}: ${entry}`));
    }
    // oxlint-disable-next-line no-await-in-loop -- counted per section, after its scroll positions
    switches += await body.getByRole("switch").count();
  }
  // An empty list only means something when switches were there to measure.
  expect(switches).toBeGreaterThan(0);
  expect([...new Set(found)]).toEqual([]);
});
