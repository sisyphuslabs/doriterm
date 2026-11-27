// Every control a finger has to hit on the phone takes a tap anywhere in the 44x44 box centred on it (#1030): Apple's
// Human Interface Guidelines put the touch minimum at 44x44 pt. A control may draw smaller (a 24 px "..." or a 36x20
// switch); its hit area is what has to reach 44.
import { devices, type Page } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { openSettingsSection } from "./settings-sections.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

/** Apple HIG's minimum touch target, in CSS px (one pt each). */
const TARGET = 44;

/**
 * Every control on screen whose box is under the target in either direction, with each point of the target box centred
 * on it that a tap does not reach it from: `<name> <w>x<h> misses <corner or edge>:<what the tap hit>`. A point is held
 * just inside the box's edge so sub-pixel rounding cannot decide it, and a point off the screen cannot be tapped at all;
 * nor can one outside the visible box of the control's own scroller (a header that stays over a scrolled list covers it,
 * #2914), where scrolling the control fully into view is the tap.
 */
const shortTargets = (page: Page): Promise<{ readonly found: readonly string[]; readonly probed: readonly string[] }> =>
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
    // The switches whose every point was tapped: centre reached and all eight inside their scroller's view.
    const probed: string[] = [];
    for (const control of controls) {
      const box = control.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || (box.width >= target && box.height >= target)) continue;
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      let view = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      for (let up = control.parentElement; up !== null; up = up.parentElement) {
        const { overflowY } = getComputedStyle(up);
        if (overflowY === "auto" || overflowY === "scroll") {
          const clip = up.getBoundingClientRect();
          view = { left: clip.left, top: clip.top, right: clip.right, bottom: clip.bottom };
          break;
        }
      }
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      // A control nothing can tap (hidden, or under another layer) is not a target on this screen.
      const centre = document.elementFromPoint(x, y);
      if (centre === null || !control.contains(centre)) continue;
      const label = control.getAttribute("aria-label") ?? control.textContent?.trim().slice(0, 40);
      let skipped = false;
      const misses = offsets.flatMap(([dx, dy]) => {
        const at = { x: x + dx, y: y + dy };
        if (at.x < view.left || at.y < view.top || at.x >= view.right || at.y >= view.bottom) {
          skipped = true;
          return [];
        }
        const hit = document.elementFromPoint(at.x, at.y);
        if (hit !== null && control.contains(hit)) return [];
        const where = `${"-0+".charAt(Math.sign(dx) + 1)}${"-0+".charAt(Math.sign(dy) + 1)}`;
        return [`${where}:${hit?.getAttribute("aria-label") ?? hit?.tagName.toLowerCase() ?? "none"}`];
      });
      if (!skipped && control.getAttribute("role") === "switch") probed.push(label ?? "");
      if (misses.length > 0) {
        found.push(`${label} ${Math.round(box.width)}x${Math.round(box.height)} misses ${misses.join(" ")}`);
      }
    }
    return { found, probed };
  }, TARGET);

test("on the phone every agent row's More, New space and fold button takes a tap anywhere in its 44x44 box", async ({
  page,
}) => {
  const agents = ["deploy", "review", "plan"].map((name) => startAgent("host", name, "idle"));
  try {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "More for plan" })).toBeVisible({ timeout: 20_000 });
    expect((await shortTargets(page)).found).toEqual([]);
  } finally {
    for (const address of agents) endAgent("host", address);
  }
});

test("on the phone every Settings switch takes a tap anywhere in its 44x44 box, on every section", async ({ page }) => {
  await page.goto("/settings");
  // A phone lists its sections on Settings' first screen, each opening the section's page (#2914).
  const sections = page.locator("[data-settings-list]").getByRole("button");
  await expect(sections.first()).toBeVisible({ timeout: 20_000 });
  const body = page.locator("[data-slot=settings-body]");
  const found: string[] = [];
  let switches = 0;
  // Every switch of every section, and those measured with their whole box in view: the two must match.
  const every = new Set<string>();
  const measured = new Set<string>();
  for (const label of await sections.allTextContents()) {
    // oxlint-disable-next-line no-await-in-loop -- one section at a time: each tap changes the page the next one reads
    await openSettingsSection(page, label);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await expect(page.getByRole("heading", { name: label, exact: true }).first()).toBeVisible();
    // oxlint-disable-next-line no-await-in-loop -- as above
    const { height, view } = await body.evaluate((element) => ({
      height: element.scrollHeight,
      view: element.clientHeight,
    }));
    for (let top = 0; top < height; top += Math.max(1, Math.floor(view * 0.75))) {
      // oxlint-disable-next-line no-await-in-loop -- each scroll position is read after the last one settles
      await body.evaluate((element, to) => element.scrollTo({ top: to }), top);
      // oxlint-disable-next-line no-await-in-loop -- as above
      const { found: short, probed } = await shortTargets(page);
      found.push(...short.map((entry) => `${label}: ${entry}`));
      for (const name of probed) measured.add(`${label}: ${name}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- counted per section, after its scroll positions
    switches += await body.getByRole("switch").count();
    // oxlint-disable-next-line no-await-in-loop -- as above
    for (const name of await body
      .getByRole("switch")
      .evaluateAll((all) =>
        all.map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? ""),
      ))
      every.add(`${label}: ${name}`);
  }
  // An empty list only means something when switches were there to measure.
  expect(switches).toBeGreaterThan(0);
  expect([...new Set(found)]).toEqual([]);
  expect(
    [...every].filter((name) => !measured.has(name)),
    "switches never measured with their whole box in view",
  ).toEqual([]);
});
