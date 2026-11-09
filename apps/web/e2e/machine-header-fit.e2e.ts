import { devices, type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { settle, visibleCharacters } from "./sidebar-measure.ts";
import { LONG_MACHINE, machineConnected, renameMachine } from "./sidebar-seed.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const spaces = (page: Page) => page.getByRole("region", { name: "Spaces", exact: true });
const header = (page: Page, name: string) => spaces(page).locator(`[data-machine-header="${name}"]`);

/** The opacity an element is drawn with: its own times every ancestor's. */
const drawnOpacity = (part: Locator) =>
  part.evaluate((element) => {
    let opacity = 1;
    for (let at: Element | null = element; at !== null; at = at.parentElement)
      opacity *= Number.parseFloat(getComputedStyle(at).opacity);
    return opacity;
  });

/** The name keeps the row; the state label gives way first, and is never drawn more legibly than the name. */
async function expectNameFirst(page: Page, name: string, state: string): Promise<void> {
  const row = header(page, name);
  await expect(row).toBeVisible({ timeout: 20_000 });
  const named = row.getByTitle(name, { exact: true });
  const stated = row.getByText(state, { exact: true });
  await expect(named).toHaveText(name);
  const kept = await visibleCharacters(named, name);
  const said = await visibleCharacters(stated, state);
  if (kept.total <= 12) expect(kept.visible, `"${name}" is drawn whole`).toBe(kept.total);
  expect(kept.visible, `"${name}" keeps more characters than "${state}"`).toBeGreaterThan(said.visible);
  expect(await drawnOpacity(named), `"${name}" is as legible as "${state}"`).toBeGreaterThanOrEqual(
    await drawnOpacity(stated),
  );
}

/**
 * Narrows the Spaces sidebar so a header row has to give: at 1440 with the pinned UI face both "build-box" and
 * "connected" fit whole, so the priority this spec asserts would not be exercised at all (#862). The row keeps its
 * layout rules; only the room it has to work with is set. A new --sidebar-width eases like a drag (sidebar.tsx), so the
 * aside is allowed to stop moving before the row is measured.
 */
const narrowSpaces = async (page: Page): Promise<void> => {
  await page.evaluate(() => document.documentElement.style.setProperty("--sidebar-width", "15.5rem"));
  await settle(page);
};

test.describe("at 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a machine header draws a short name whole and keeps more of a long name than of its state", async ({
    page,
  }) => {
    await machineConnected(MACHINE_NAME);
    await page.goto("/");
    await narrowSpaces(page);
    await expectNameFirst(page, MACHINE_NAME, "connected");

    const restore = renameMachine();
    try {
      await machineConnected(LONG_MACHINE);
      await page.reload();
      await narrowSpaces(page);
      await expectNameFirst(page, LONG_MACHINE, "connected");
    } finally {
      restore();
    }
  });
});

const { defaultBrowserType: _browser, ...PHONE } = devices["iPhone 14"];

test.describe("at 390 with touch", () => {
  test.use(PHONE);

  test("New space and Collapse each take a tap 10 px past their drawn box, and their hit areas do not meet", async ({
    page,
  }) => {
    await page.goto("/");
    const group = spaces(page).getByRole("region").first();
    const add = group.getByRole("button", { name: /^New space on / });
    const fold = group.getByRole("button", { name: /^Collapse / });
    await expect(add).toBeEnabled({ timeout: 20_000 });
    await expect(fold).toBeVisible();

    const boxes = await Promise.all([add.boundingBox(), fold.boundingBox()]);
    const [left, right] = boxes;
    if (left === null || right === null) throw new Error("no box");
    for (const box of boxes) {
      expect(box?.width, "the drawn button stays 24 px").toBe(24);
      expect(box?.height, "the drawn button stays 24 px").toBe(24);
    }
    // 10 px each side of a 24 px box is a 44 px hit area; two of them meet only when the boxes are 20 px apart or less.
    expect(right.x - (left.x + left.width), "the hit areas do not overlap").toBeGreaterThanOrEqual(20);

    // Just inside the 10 px edge, so sub-pixel rounding of the hit area cannot decide the result.
    const OUT = 9.5;
    const labels = await Promise.all([add.getAttribute("aria-label"), fold.getAttribute("aria-label")]);
    const points = [left, right].flatMap((box, index) => {
      const midX = box.x + box.width / 2;
      const midY = box.y + box.height / 2;
      const label = labels[index] ?? null;
      return [
        { side: "left", x: box.x - OUT, y: midY, label },
        { side: "right", x: box.x + box.width + OUT, y: midY, label },
        { side: "top", x: midX, y: box.y - OUT, label },
        { side: "bottom", x: midX, y: box.y + box.height + OUT, label },
        // The corners too: the rows above and below and the list's edge must not take any of the 44 px (#504 re-test).
        { side: "top-left", x: box.x - OUT, y: box.y - OUT, label },
        { side: "top-right", x: box.x + box.width + OUT, y: box.y - OUT, label },
        { side: "bottom-left", x: box.x - OUT, y: box.y + box.height + OUT, label },
        { side: "bottom-right", x: box.x + box.width + OUT, y: box.y + box.height + OUT, label },
      ];
    });
    const hits = await page.evaluate(
      (at) =>
        at.map(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label") ?? null),
      points,
    );
    points.forEach(({ side, label }, index) =>
      expect.soft(hits[index], `a tap 10 px ${side} of "${label}" reaches it`).toBe(label),
    );
  });
});
