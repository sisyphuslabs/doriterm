// herdr-app's tab strip (herdrdev/herdr-app 4ed0efd3, defaults/mods/tabs/main.js), the #466 round-3 items 5, 7, 8 and 9.
import type { Page } from "@playwright/test";
import { agentRow, endAgent, startAgent } from "./agents.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { openFour, selectedIndex, strip, tabOf, tabs } from "./tab-strip.ts";

endOwnTerminals();

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

const newTab = (page: Page) => page.getByRole("button", { name: "New tab", exact: true });

test("5: + sits outside the scrolling tabs, so with 22 tabs it stays in view and the tabs scroll", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await openNewTerminal(page);
  const missing = 22 - (await tabs(page).count());
  // One at a time: openNewTerminal waits for each new tab to take focus before the next.
  await Array.from({ length: missing }).reduce<Promise<unknown>>(
    (previous) => previous.then(() => openNewTerminal(page)),
    Promise.resolve(),
  );
  await expect(tabs(page)).toHaveCount(22);

  const plus = newTab(page);
  expect(await plus.evaluate((button) => button.closest('[role="tablist"]') === null)).toBe(true);
  // In the window and the topmost element at its centre: nothing covers it and it has not scrolled away.
  const box = await plus.boundingBox();
  if (box === null) throw new Error("New tab has no box");
  expect(box.x + box.width).toBeLessThanOrEqual(1440);
  const hit = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label") ?? null,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  expect(hit).toBe("New tab");

  // The ordinary tabs scroll inside the strip; pinned ones (#1561) sit before them, out of the scroller.
  const list = await strip(page)
    .locator("[data-tab-scroll]")
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        overflows: element.scrollWidth > element.clientWidth,
        overflowX: style.overflowX,
        scrollbarWidth: style.scrollbarWidth,
      };
    });
  expect(list).toEqual({ overflows: true, overflowX: "auto", scrollbarWidth: "thin" });
  // The newest tab is the selected one, scrolled into view rather than past the strip's end (fractional tab widths
  // can leave a sub-pixel sliver clipped, hence not 1).
  await expect(
    strip(page)
      .locator("[data-tab-id]")
      .filter({ has: page.getByRole("tab", { selected: true }) }),
  ).toBeInViewport({
    ratio: 0.9,
  });
});

test("7: + opens the new menu (a terminal, the agents hc can start, a new space); Ctrl+Shift+T stays a new tab", async ({
  page,
}) => {
  await page.goto("/");
  await openNewTerminal(page);
  const before = await tabs(page).count();

  await newTab(page).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: /^Terminal/ })).toBeVisible();
  await expect(menu.getByText("Start an agent")).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "New space" })).toBeVisible();
  // The agents come from hc's templates; this host's list has loaded once Checking is gone.
  await expect(menu.getByText("Checking installed agents…")).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(before);

  await menu.getByRole("menuitem", { name: /^Terminal/ }).click();
  await expect(tabs(page)).toHaveCount(before + 1);

  await newTab(page).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "New space" }).click();
  await expect(tabs(page)).toHaveCount(1, { timeout: 15_000 });
});

test("8: the wheel over the strip wraps at the ends, as tab.next and tab.prev", async ({ page }) => {
  await openFour(page);
  await tabs(page).nth(3).click();
  await expect.poll(() => selectedIndex(page)).toBe(3);
  await strip(page).hover();
  await page.mouse.wheel(0, 100);
  await expect.poll(() => selectedIndex(page)).toBe(0);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => selectedIndex(page)).toBe(3);
});

test("9: a tab is 29 px tall with radius 7, 3 px apart, its label capped at 170 px", async ({ page }) => {
  await openFour(page);
  await tabs(page).nth(0).click();
  const items = strip(page).locator("[data-tab-id]");
  const measured = await items.evaluateAll(async (elements) => {
    // A new tab arrives from scale(0.97) (motion-arrive), and a transform scales its box too: under load the newest tab's
    // arrival can still be running here, a frame short of 29 px (28.9994, #696). Its resting box is the one measured.
    await Promise.all(elements.flatMap((element) => element.getAnimations().map((animation) => animation.finished)));
    return elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const label = element.querySelector('[role="tab"] span.truncate');
      return {
        left: rect.left,
        right: rect.right,
        height: rect.height,
        radius: getComputedStyle(element).borderTopLeftRadius,
        labelMax: label === null ? null : getComputedStyle(label).maxWidth,
      };
    });
  });
  for (const tab of measured) {
    expect.soft(tab.height).toBe(29);
    expect.soft(tab.radius).toBe("7px");
    expect.soft(tab.labelMax).toBe("170px");
  }
  for (let index = 1; index < measured.length; index += 1) {
    const gap = (measured[index]?.left ?? 0) - (measured[index - 1]?.right ?? 0);
    expect.soft(Math.round(gap)).toBe(3);
  }
});

test("9: an idle agent's tab draws no status glyph, as herdr-app's", async ({ page }) => {
  const address = startAgent("host", "idle-tab-agent", "idle");
  try {
    await page.goto("/");
    await agentRow(page, "idle-tab-agent", false).click({ timeout: 20_000 });
    const tab = await tabOf(page, address);
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
    await expect(tab.getByRole("img", { name: /^(Idle|Unknown)$/ })).toHaveCount(0);
  } finally {
    endAgent("host", address);
  }
});
