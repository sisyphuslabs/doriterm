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
      for (let x = Math.max(label.left, box.left) + 0.5; x < Math.min(label.right, box.right); x += 2) {
        const hit = document.elementFromPoint(x, y);
        if (hit === null || !tab.contains(hit)) {
          occluded.push(
            `${tab.textContent ?? ""}@${Math.round(x)}: ${hit?.getAttribute("data-tab-edge") ?? hit?.tagName}`,
          );
        }
      }
    }
    const startCue = list.parentElement?.querySelector('[data-tab-edge="start"]') !== null;
    return { scrollLeft: list.scrollLeft, startCue, occluded, cutAtStart, clipped };
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

test("no tab label is under a paging cue at rest, after paging to the end, or after paging back", async ({
  page: tab,
}) => {
  await tab.goto("/settings");
  await expect(tab.getByRole("tab", { name: "Connections" })).toBeVisible();
  await expect(tab.locator('[data-tab-edge="end"]')).toHaveCount(1);

  const rest = await strip(tab);
  expect(rest).toMatchObject({ scrollLeft: 0, startCue: false, occluded: [], cutAtStart: [] });
  expect(rest.clipped).toContain("Keybindings");

  await pageTo(tab, "end");
  const end = await strip(tab);
  expect([end.startCue, end.occluded]).toEqual([true, []]);
  expect(end.clipped).not.toContain("Keybindings");

  await pageTo(tab, "start");
  expect(await strip(tab)).toMatchObject({ scrollLeft: 0, startCue: false, occluded: [], cutAtStart: [] });
});
