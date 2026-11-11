import { devices, type Locator, type Page } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

const reached = (page: Page, points: readonly { readonly x: number; readonly y: number }[]) =>
  page.evaluate(
    (at) =>
      at.map(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label") ?? "MISS"),
    points,
  );

/** The right-most point anything the row draws reaches: every child of the row's own button, the way it is laid out. */
const drawnEdge = (row: Locator) =>
  row.evaluate((button) => {
    const rights = [...button.children].map((child) => child.getBoundingClientRect().right);
    return rights.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...rights);
  });

test("on the phone an agent row draws More alone, which takes a tap just inside 10 px of its box and holds Pin", async ({
  page,
}) => {
  // #950 (after #798/#808): a touch screen draws More only; Pin is its menu's first item, and the row keeps its meta.
  const address = startAgent("host", "tapme", "idle");
  // The two shapes that used to be drawn under the actions: a detail far longer than the row, and a "Blocked" chip,
  // which is not meta at all, so hiding the meta never moved it out from under the action.
  const long = startAgent("host", "longrow", "idle", "a-long-space-name-for-the-detail");
  const blocked = startAgent("host", "blockrow", "blocked");
  try {
    await page.goto("/");
    const row = page.getByRole("button", { name: /tapme/ }).first();
    const more = page.getByRole("button", { name: "More for tapme" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(more).toBeVisible();
    await expect(page.getByRole("button", { name: "Pin tapme" })).toBeHidden();

    const box = await more.boundingBox();
    if (box === null) throw new Error("no box");
    expect(box.width, "the drawn button stays 24 px").toBe(24);
    expect(box.height, "the drawn button stays 24 px").toBe(24);

    // Just inside the 10 px edge, so sub-pixel rounding of the hit area cannot decide the result.
    const OUT = 9.5;
    const label = await more.getAttribute("aria-label");
    const midX = box.x + box.width / 2;
    const midY = box.y + box.height / 2;
    const points = [
      { side: "left", x: box.x - OUT, y: midY },
      { side: "right", x: box.x + box.width + OUT, y: midY },
      { side: "top", x: midX, y: box.y - OUT },
      { side: "bottom", x: midX, y: box.y + box.height + OUT },
      { side: "top-left", x: box.x - OUT, y: box.y - OUT },
      { side: "top-right", x: box.x + box.width + OUT, y: box.y - OUT },
      { side: "bottom-left", x: box.x - OUT, y: box.y + box.height + OUT },
      { side: "bottom-right", x: box.x + box.width + OUT, y: box.y + box.height + OUT },
    ];
    const hits = await reached(page, points);
    points.forEach(({ side }, index) =>
      expect.soft(hits[index], `a tap 10 px ${side} of "${label}" reaches it`).toBe(label),
    );

    // A keyboard on a touch screen (a tablet's) still reaches More from the row: ArrowRight skips the Pin it does not draw.
    await row.focus();
    await page.keyboard.press("ArrowRight");
    await expect(more).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(row).toBeFocused();

    // The blocked agent is pinned first from its own More, so Pinned keeps it and its "Needs you" chip draws.
    await page.getByRole("button", { name: "More for blockrow" }).tap();
    await page.getByRole("menuitem", { name: "Pin to top" }).tap();
    await expect(page.getByRole("button", { name: /blockrow/ }).first()).toContainText("Needs you");
    const shapes = ["longrow", "blockrow"] as const;
    await Promise.all(
      shapes.map(async (name) => {
        const other = page.getByRole("button", { name: new RegExp(`\\b${name}\\b`) }).first();
        await expect(other).toBeVisible();
        const [edge, moreBox] = await Promise.all([
          drawnEdge(other),
          page.getByRole("button", { name: `More for ${name}` }).boundingBox(),
        ]);
        if (moreBox === null) throw new Error(`no box for ${name}`);
        expect(edge, `${name}: nothing the row draws runs under its More`).toBeLessThanOrEqual(moreBox.x);
        await expect(other.locator("[data-row-meta]").first()).toHaveCSS("visibility", "visible");
      }),
    );

    // A space row, on the Spaces tab, is its own signal: its status dot and tab count stay in its name, and it draws no "...".
    await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Spaces", exact: true }).tap();
    await expect(page.getByRole("button", { name: /\d+ tabs/ }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "More for api" })).toHaveCount(0);
    await page.goBack();
    await expect(more).toBeVisible();

    // Pin is More's first item, so the action the row no longer draws is one tap further.
    await more.tap();
    const items = page.getByRole("menuitem");
    await expect(items.first()).toHaveText("Pin to top");
    await items.first().tap();
    await expect(page.getByRole("button", { name: /tapme/ }).first()).toBeVisible();
    await page.getByRole("button", { name: "More for tapme" }).tap();
    await expect(page.getByRole("menuitem").first()).toHaveText("Unpin");
  } finally {
    endAgent("host", address);
    endAgent("host", long);
    endAgent("host", blocked);
  }
});
