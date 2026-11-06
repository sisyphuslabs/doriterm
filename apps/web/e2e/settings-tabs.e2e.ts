// The phone-width Settings tab strip: paging cues never draw over a tab label, and the strip rests at its start.
import { devices, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use(phone);

interface Strip {
  readonly scrollLeft: number;
  readonly startCue: boolean;
  /** Label points another element draws over, as `<label>@<x>: <element>`. */
  readonly occluded: readonly string[];
  /** Labels cut off at the strip's start edge. */
  readonly cutAtStart: readonly string[];
  /** Labels not wholly inside the strip, left to right. */
  readonly clipped: readonly string[];
  readonly width: number;
  /** How far a paging cue's box reaches into the list's box, in device pixels. */
  readonly cueOverlap: number;
}

const strip = (page: Page): Promise<Strip> =>
  page.getByRole("tablist").evaluate((list) => {
    const box = list.getBoundingClientRect();
    const occluded: string[] = [];
    const cutAtStart: string[] = [];
    const clipped: string[] = [];
    for (const tab of list.querySelectorAll('[role="tab"]')) {
      const range = document.createRange();
      range.selectNodeContents(tab);
      const label = range.getBoundingClientRect();
      if (label.left < box.left - 0.5 && label.right > box.left) cutAtStart.push(tab.textContent ?? "");
      if (label.left < box.left - 0.5 || label.right > box.right + 0.5) clipped.push(tab.textContent ?? "");
      const y = label.top + label.height / 2;
      // Hit-testing resolves to whole CSS pixels (measured on Linux Chromium at DPR 3: every point in the list's last
      // pixel, 357..358, hit the cue that starts at 358), so the scan stays one CSS pixel inside each end of the list;
      // cueOverlap checks the boxes themselves.
      for (let x = Math.max(label.left, box.left) + 1; x < Math.min(label.right, box.right) - 1; x += 2) {
        const hit = document.elementFromPoint(x, y);
        if (hit === null || !tab.contains(hit)) {
          occluded.push(
            `${tab.textContent ?? ""}@${Math.round(x)}: ${hit?.getAttribute("data-tab-edge") ?? hit?.tagName}`,
          );
        }
      }
    }
    const startCue = list.parentElement?.querySelector('[data-tab-edge="start"]') !== null;
    const reach = [...(list.parentElement?.querySelectorAll("[data-tab-edge]") ?? [])].map((cue) => {
      const edge = cue.getBoundingClientRect();
      return Math.max(0, Math.min(edge.right, box.right) - Math.max(edge.left, box.left));
    });
    const cueOverlap = Math.max(0, ...reach) * devicePixelRatio;
    return { scrollLeft: list.scrollLeft, startCue, occluded, cutAtStart, clipped, width: box.width, cueOverlap };
  });

/** Clicks a paging cue and waits for the strip's scroll, snapping included, to end. */
async function pageTo(on: Page, side: "start" | "end"): Promise<void> {
  const list = on.getByRole("tablist");
  await list.evaluate((element) => {
    const done = new Promise<void>((resolve) => element.addEventListener("scrollend", () => resolve(), { once: true }));
    Object.assign(element, { scrolled: done });
  });
  await on.locator(`[data-tab-edge="${side}"]`).click();
  await list.evaluate((element) => ("scrolled" in element ? element.scrolled : undefined));
  await expect(on.locator(`[data-tab-edge="${side === "end" ? "start" : "end"}"]`)).toHaveCount(1);
}

/** Pages until that side's cue is gone: with more sections than two screens hold, one page is not the end. */
async function pageAll(on: Page, side: "start" | "end"): Promise<void> {
  if ((await on.locator(`[data-tab-edge="${side}"]`).count()) === 0) return;
  await pageTo(on, side);
  return pageAll(on, side);
}

test("no tab label is under a paging cue at rest, after paging to the end, or after paging back", async ({
  page: tab,
}) => {
  await tab.goto("/settings");
  await expect(tab.getByRole("tab", { name: "Connections" })).toBeVisible();
  await expect(tab.locator('[data-tab-edge="end"]')).toHaveCount(1);

  const rest = await strip(tab);
  expect(rest.cueOverlap).toBeLessThanOrEqual(1);
  expect(rest).toMatchObject({ scrollLeft: 0, startCue: false, occluded: [], cutAtStart: [] });
  expect(rest.clipped).toContain("Keybindings");

  await pageAll(tab, "end");
  const end = await strip(tab);
  expect(end.cueOverlap).toBeLessThanOrEqual(1);
  expect([end.startCue, end.occluded]).toEqual([true, []]);
  expect(end.clipped).not.toContain("Keybindings");

  await pageAll(tab, "start");
  const back = await strip(tab);
  expect(back.cueOverlap).toBeLessThanOrEqual(1);
  expect(back).toMatchObject({ scrollLeft: 0, startCue: false, occluded: [], cutAtStart: [] });
  expect([end.width, back.width]).toEqual([rest.width, rest.width]);
});

test("each paging cue takes a 44 pt tap on a phone, at rest and paged to the end (#892)", async ({ page: tab }) => {
  await tab.goto("/settings");
  const sizes = async () =>
    tab.locator("[data-tab-edge]").evaluateAll((cues) =>
      cues.map((cue) => {
        const box = cue.getBoundingClientRect();
        return `${cue.getAttribute("data-tab-edge") ?? ""} ${Math.round(box.width)}x${Math.round(box.height)}`;
      }),
    );
  await expect(tab.locator('[data-tab-edge="end"]')).toHaveCount(1);
  expect(await sizes()).toEqual(["end 44x44"]);
  await pageAll(tab, "end");
  expect(await sizes()).toEqual(["start 44x44"]);
});

test("a keyboard-focused tab's ring is drawn whole, inside the strip", async ({ page: tab }) => {
  await tab.goto("/settings");
  await tab.getByRole("tab", { name: "Connections" }).focus();
  await tab.keyboard.press("ArrowRight");
  const focused = tab.getByRole("tab", { name: "Mesh" });
  await expect(focused).toBeFocused();
  const ring = await focused.evaluate((element) => {
    const style = getComputedStyle(element);
    const reach = Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth);
    const own = element.getBoundingClientRect();
    const box = element.closest('[role="tablist"]')?.getBoundingClientRect();
    return {
      style: style.outlineStyle,
      top: box === undefined ? -1 : own.top - reach - box.top,
      bottom: box === undefined ? -1 : box.bottom - (own.bottom + reach),
    };
  });
  expect(ring.style).toBe("solid");
  expect(ring.top).toBeGreaterThanOrEqual(0);
  expect(ring.bottom).toBeGreaterThanOrEqual(0);
});
