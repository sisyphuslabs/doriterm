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

test("an agent row's Pin and More are on the phone, and each takes a tap just inside 10 px of its drawn box", async ({
  page,
}) => {
  const address = startAgent("host", "tapme", "idle");
  // The two shapes that used to be drawn under the actions: a detail far longer than the row, and a "Blocked" chip,
  // which is not meta at all, so hiding the meta never moved it out from under the Pin.
  const long = startAgent("host", "longrow", "idle", "a-long-space-name-for-the-detail");
  const blocked = startAgent("host", "blockrow", "blocked");
  try {
    await page.goto("/");
    const row = page.getByRole("button", { name: /tapme/ }).first();
    const pin = page.getByRole("button", { name: /^Pin tapme to the top$/ });
    const more = page.getByRole("button", { name: "More for tapme" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(pin).toBeVisible();

    const boxes = await Promise.all([pin.boundingBox(), more.boundingBox()]);
    const [left, right] = boxes;
    if (left === null || right === null) throw new Error("no box");
    for (const box of boxes) {
      expect(box?.width, "the drawn button stays 24 px").toBe(24);
      expect(box?.height, "the drawn button stays 24 px").toBe(24);
    }
    expect(right.x - (left.x + left.width), "the two hit areas neither overlap nor meet").toBeGreaterThanOrEqual(24);

    // Just inside the 10 px edge, so sub-pixel rounding of the hit area cannot decide the result.
    const OUT = 9.5;
    const labels = [await pin.getAttribute("aria-label"), await more.getAttribute("aria-label")];
    const points = [left, right].flatMap((box, index) => {
      const midX = box.x + box.width / 2;
      const midY = box.y + box.height / 2;
      const label = labels[index] ?? null;
      return [
        { side: "left", x: box.x - OUT, y: midY, label },
        { side: "right", x: box.x + box.width + OUT, y: midY, label },
        { side: "top", x: midX, y: box.y - OUT, label },
        { side: "bottom", x: midX, y: box.y + box.height + OUT, label },
        { side: "top-left", x: box.x - OUT, y: box.y - OUT, label },
        { side: "top-right", x: box.x + box.width + OUT, y: box.y - OUT, label },
        { side: "bottom-left", x: box.x - OUT, y: box.y + box.height + OUT, label },
        { side: "bottom-right", x: box.x + box.width + OUT, y: box.y + box.height + OUT, label },
      ];
    });
    const hits = await reached(page, points);
    points.forEach(({ side, label }, index) =>
      expect.soft(hits[index], `a tap 10 px ${side} of "${label}" reaches it`).toBe(label),
    );

    // The two shapes that used to be drawn under the actions: a detail far longer than the row, and the "Needs you" chip
    // of a blocked agent, which is not meta at all, so hiding the meta never moved it out from under the Pin. The chip
    // only draws outside the compact blocked group, so the blocked agent is pinned first: Pinned keeps it.
    await page.getByRole("button", { name: /^Pin blockrow to the top$/ }).tap();
    await expect(page.getByRole("button", { name: /blockrow/ }).first()).toContainText("Needs you");
    const shapes = ["longrow", "blockrow"] as const;
    await Promise.all(
      shapes.map(async (name) => {
        const other = page.getByRole("button", { name: new RegExp(`\\b${name}\\b`) }).first();
        await expect(other).toBeVisible();
        const [edge, pinBox] = await Promise.all([
          drawnEdge(other),
          page.getByRole("button", { name: `Pin ${name}` }).boundingBox(),
        ]);
        if (pinBox === null) throw new Error(`no box for ${name}`);
        expect(edge, `${name}: nothing the row draws runs under its actions`).toBeLessThanOrEqual(pinBox.x);
        await expect(other.locator("[data-row-meta]").first()).toHaveCSS("visibility", "visible");
      }),
    );

    // A space row's meta is its own signal: its status dot and tab count stay in its name, and its "..." waits for a hover.
    await expect(page.getByRole("button", { name: /\d+ tabs/ }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "More for api" })).toHaveCount(0);

    await pin.tap();
    await expect(page.getByRole("button", { name: "Unpin tapme" })).toBeVisible();
  } finally {
    endAgent("host", address);
    endAgent("host", long);
    endAgent("host", blocked);
  }
});
