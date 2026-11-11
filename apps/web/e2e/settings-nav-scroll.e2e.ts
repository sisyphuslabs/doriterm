// The desktop Settings nav holds the window's drag row as well as the section list: in a window too short for the
// sections, the list scrolls and the title row stays, so the window can still be dragged by it (#1915).
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 320 } });

const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });
const nav = (page: Page) => settings(page).getByRole("navigation", { name: "Settings" });
const sections = (page: Page) => nav(page).locator("[data-slot=settings-sections]");
const SECTION_COUNT = 8;

/** A box that is on screen; a check against a missing one would pass for the wrong reason. */
async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${locator} has no box: it is not on screen`);
  return box;
}

async function openSettings(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(sections(page)).toBeVisible();
}

test("in a short window the Settings sections scroll under a title row that stays (#1915)", async ({ page }) => {
  await openSettings(page);
  const title = nav(page).getByRole("heading", { name: "Settings" });
  const last = nav(page).getByRole("button", { name: "Voice input" });
  const titleAt = await boxOf(title);
  const lastAt = await boxOf(last);

  await sections(page).hover();
  await page.mouse.wheel(0, 400);

  // The sections scrolled: the one at the end of the list moved up.
  await expect.poll(async () => (await boxOf(last)).y).toBeLessThan(lastAt.y - 20);
  // The title row, which is also the window's drag region, did not move with them.
  expect((await boxOf(title)).y).toBe(titleAt.y);
});

test("every section button's focus ring is drawn whole as the keyboard reaches it, never cut by the scroller (#1915)", async ({
  page,
}) => {
  await openSettings(page);
  await settings(page).getByRole("searchbox", { name: "Search settings" }).click();
  // The scroller itself is the next stop, so a keyboard can scroll it, as Settings' body can; its ring is drawn inside.
  await page.keyboard.press("Tab");
  await expect(sections(page)).toBeFocused();
  // Each Tab moves on from the stop before it, so the stops are checked one after another.
  const checkFrom = async (stop: number): Promise<void> => {
    if (stop === SECTION_COUNT) return;
    await page.keyboard.press("Tab");
    const focused = sections(page).locator("button:focus-visible");
    await expect(focused).toHaveCount(1);
    // The ring is read from the button as drawn, so a ring that went away cannot make this pass.
    const drawn = await focused.evaluate((button) => {
      const style = getComputedStyle(button);
      const scroller = button.closest("[data-slot=settings-sections]");
      if (scroller === null) throw new Error("a section button outside the sections scroller");
      const ring = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
      const at = button.getBoundingClientRect();
      const clip = scroller.getBoundingClientRect();
      return {
        ring,
        cut: {
          left: clip.left - (at.left - ring),
          right: at.right + ring - clip.right,
          top: clip.top - (at.top - ring),
          bottom: at.bottom + ring - clip.bottom,
        },
      };
    });
    expect(drawn.ring).toBeGreaterThan(0);
    // How far the ring runs past the scroller's edge on each side: nothing, give or take a sub-pixel.
    for (const side of ["left", "right", "top", "bottom"] as const) expect(drawn.cut[side]).toBeLessThan(0.5);
    await checkFrom(stop + 1);
  };
  await checkFrom(0);
});
