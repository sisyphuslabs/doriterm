import { atRest } from "./at-rest.ts";
import { expect, laidOutBox, test } from "./fixtures.ts";
import type { Page } from "@playwright/test";

/**
 * The macOS app's titlebar sheets, as apps/desktop/src/config/window.ts writes them (MAC_TITLEBAR_CSS): the window
 * buttons' inset, and the drag regions a titlebar row and the controls inside it carry. A browser never applies these to
 * a press, so the sheet is injected here and the region rule is read from the DOM instead.
 */
const TITLEBAR_INSET_START = 78;
const RAIL_WIDTH = 76;
const MAC_TITLEBAR_SHEET = [
  `:root { --titlebar-inset-start: ${TITLEBAR_INSET_START}px; --sidebar-rail-width: ${RAIL_WIDTH}px; }`,
  'html::before { content: ""; position: fixed; inset: 0 0 auto 0; height: 8px; -webkit-app-region: drag; }',
  "[data-titlebar] { -webkit-app-region: drag; }",
  `[data-titlebar] :is(a, button, input, select, textarea, [role="tab"], [role="button"], [tabindex], [data-tab-id]) { -webkit-app-region: no-drag; }`,
].join("\n");

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });
const toggle = (page: Page) => page.getByRole("button", { name: /^(Hide|Show) sidebar$/ });

/**
 * What the macOS window does with a press at a point: Blink collects the app regions in layout order and Electron adds
 * and subtracts them in that order, so the region over the point that comes last decides whether the press drags the
 * window. Pseudo-element regions (the band the window buttons sit in) come first, so they never overrule a control.
 */
function regionAt(page: Page, x: number, y: number): Promise<"drag" | "no-drag" | null> {
  return page.evaluate(
    (point) => {
      let answer: "drag" | "no-drag" | null = null;
      for (const element of document.querySelectorAll<HTMLElement>("html, body, body *")) {
        const region = getComputedStyle(element).getPropertyValue("-webkit-app-region").trim();
        if (region !== "drag" && region !== "no-drag") continue;
        const box = element.getBoundingClientRect();
        if (point.x < box.left || point.x >= box.right || point.y < box.top || point.y >= box.bottom) continue;
        answer = region;
      }
      return answer;
    },
    { x, y },
  );
}

/** The toggle takes a press everywhere inside it, not only where no drag region happens to lie under it. */
async function expectToggleTakesPresses(page: Page, state: string): Promise<void> {
  const box = await laidOutBox(toggle(page));
  const pressed = await Promise.all(
    (
      [
        [0.5, 0.5],
        [0.5, 0.2],
        [0.5, 0.8],
        [0.2, 0.5],
        [0.8, 0.5],
      ] as const
    ).map(async ([dx, dy]) => ({
      at: `${dx} across and ${dy} down`,
      region: await regionAt(page, box.x + box.width * dx, box.y + box.height * dy),
    })),
  );
  for (const { at, region } of pressed) {
    expect(region, `${state}: a press on the sidebar toggle ${at} of it drags the window instead`).toBe("no-drag");
  }
}

/** The strip's empty stretch, right of the last tab, still drags the window, as a titlebar row does. */
async function expectStripStillDrags(page: Page, state: string): Promise<void> {
  const strip = await laidOutBox(page.getByRole("tablist", { name: "Tabs" }));
  const region = await regionAt(page, strip.x + strip.width - 12, strip.y + strip.height / 2);
  expect(region, `${state}: the tab strip's empty stretch no longer drags the window`).toBe("drag");
}

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

test("the sidebar toggle takes a press with the sidebar open, hidden or a rail, as the macOS window reads it", async ({
  page,
}) => {
  await page.goto("/");
  await expect(sidebar(page)).toBeVisible({ timeout: 20_000 });
  await page.addStyleTag({ content: MAC_TITLEBAR_SHEET });

  await expectToggleTakesPresses(page, "open");
  await expectStripStillDrags(page, "open");

  // Hidden: the toggle that hid it is the only way back, and the strip now runs under it.
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(sidebar(page)).toBeHidden();
  await expectToggleTakesPresses(page, "hidden");
  await expectStripStillDrags(page, "hidden");

  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(sidebar(page)).toBeVisible();

  // A rail: the sidebar is drawn narrow, and the strip starts past it as it does with the sidebar hidden.
  await page.getByRole("separator", { name: "Resize sidebar" }).focus();
  await page.keyboard.press("Enter");
  await expect(sidebar(page)).toHaveAttribute("data-rail", "true");
  // The sidebar narrows into the rail on the motion tokens: measure the strip where it stays, not mid-slide (#2910).
  await atRest(page);
  await expectToggleTakesPresses(page, "rail");
  await expectStripStillDrags(page, "rail");

  // The toggle still hides and brings back the sidebar, once a press reaches it.
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(sidebar(page)).toBeHidden();
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(sidebar(page)).toBeVisible();
});
