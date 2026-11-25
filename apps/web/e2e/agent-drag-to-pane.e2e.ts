import type { Locator, Page } from "@playwright/test";
import { startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { fractionOf, paneOf, savedTab, seedLayout } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { rows } from "./sidebar-measure.ts";

test.use({ serviceWorkers: "block" });

const shells: { readonly core: "host" | "machine"; readonly address: string }[] = [];
test.afterEach(() => {
  for (const { core, address } of shells.splice(0)) hcOn(core, ["kill", address]);
});

const shell = (name: string, core: "host" | "machine" = "host"): string => {
  const address = startShell(core, name);
  shells.push({ core, address });
  return address;
};

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });
/** The sidebar's row for the agent named `name`. */
const rowOf = (page: Page, name: string): Locator =>
  rows(sidebar(page)).filter({ has: page.locator(`[data-floor="name"][title="${name}"]`) });
const overlay = (page: Page) => page.locator("[data-pane-drop]");
const chip = (page: Page) => page.locator("[data-terminal-drag]");

/** Tab `a` shows `left | right`, tab `b` shows `other` alone; tab `a` is the one in view. */
function seedTwoTabs(a: string, b: string, [left, right, other]: readonly string[]): void {
  seedLayout([
    {
      id: a,
      root: [
        { pane: `p-${a}-1`, terminal: left ?? "" },
        { pane: `p-${a}-2`, terminal: right ?? "" },
      ],
    },
    { id: b, root: [{ pane: `p-${b}-1`, terminal: other ?? "" }] },
  ]);
}

async function centreOf(of: Locator): Promise<{ readonly x: number; readonly y: number }> {
  const box = await of.boundingBox();
  if (box === null) throw new Error("no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Presses the row and moves, in small steps as a hand does, to (fx, fy) of `to`; the button stays down. */
async function dragRowTo(page: Page, row: Locator, to: Locator, fx: number, fy: number): Promise<void> {
  const from = await centreOf(row);
  const target = await to.boundingBox();
  if (target === null) throw new Error("no target box");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width * fx, target.y + target.height * fy, { steps: 16 });
}

test("an agent dragged from the sidebar onto a pane's edge becomes a pane there, leaving the tab it was in", async ({
  page,
}) => {
  const [t1, t2, t3] = ["drop-1", "drop-2", "drop-3"].map((name) => shell(name));
  seedTwoTabs("tb-da", "tb-db", [t1 ?? "", t2 ?? "", t3 ?? ""]);
  await page.goto("/");
  await expect(paneOf(page, t2 ?? "")).toBeVisible({ timeout: 15_000 });
  await expect(rowOf(page, "drop-3")).toBeVisible({ timeout: 15_000 });

  // herdr-app's zones: the outer quarter picks the nearest edge, and the preview is the half the new pane takes.
  await dragRowTo(page, rowOf(page, "drop-3"), paneOf(page, t2 ?? ""), 0.92, 0.5);
  await expect(chip(page)).toHaveText("drop-3");
  await expect(overlay(page)).toHaveAttribute("data-pane-drop", "right");
  const [shown, target] = [await overlay(page).boundingBox(), await paneOf(page, t2 ?? "").boundingBox()];
  if (shown === null || target === null) throw new Error("no preview or target box");
  expect(Math.abs(shown.x - (target.x + target.width / 2))).toBeLessThanOrEqual(2);
  expect(Math.abs(shown.width - target.width / 2)).toBeLessThanOrEqual(2);
  await page.mouse.up();
  await expect(overlay(page)).toHaveCount(0);
  await expect(chip(page)).toHaveCount(0);

  await expect.poll(() => savedTab("tb-da"), { timeout: 15_000 }).toBe("tb-da(p-tb-da-1,p-tb-da-2@0.5,p-tb-db-1@0.5)");
  // Its tab had no other pane, so it went with it.
  expect(savedTab("tb-db")).toBeNull();
  await expect(paneOf(page, t3 ?? "")).toHaveAttribute("data-focused", "true", { timeout: 15_000 });
  const [second, third] = [await fractionOf(page, t2 ?? ""), await fractionOf(page, t3 ?? "")];
  expect(third.x).toBeGreaterThan(second.x);
});

test("the middle trades places, Escape and a release off the panes drop nothing, a click still opens, and another machine's agent finds no pane", async ({
  page,
}) => {
  const [t4, t5, t6] = ["swap-4", "swap-5", "swap-6"].map((name) => shell(name));
  const away = shell("away-7", "machine");
  seedTwoTabs("tb-sa", "tb-sb", [t4 ?? "", t5 ?? "", t6 ?? ""]);
  await page.goto("/");
  await expect(paneOf(page, t5 ?? "")).toBeVisible({ timeout: 15_000 });
  await expect(rowOf(page, "swap-6")).toBeVisible({ timeout: 15_000 });
  const before = { a: savedTab("tb-sa"), b: savedTab("tb-sb") };

  await dragRowTo(page, rowOf(page, "swap-6"), paneOf(page, t5 ?? ""), 0.5, 0.5);
  await expect(overlay(page)).toHaveAttribute("data-pane-drop", "swap");
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toHaveCount(0);
  await expect(chip(page)).toHaveCount(0);
  await page.mouse.up();

  // Let go over the sidebar: no pane is there, so nothing lands.
  await dragRowTo(page, rowOf(page, "swap-6"), paneOf(page, t5 ?? ""), 0.5, 0.5);
  await expect(overlay(page)).toHaveAttribute("data-pane-drop", "swap");
  const list = await centreOf(sidebar(page));
  await page.mouse.move(list.x, list.y, { steps: 8 });
  await expect(overlay(page)).toHaveCount(0);
  await page.mouse.up();
  expect({ a: savedTab("tb-sa"), b: savedTab("tb-sb") }).toEqual(before);

  // A terminal of another machine has no place in this machine's document: no pane takes it.
  await expect(rowOf(page, "away-7")).toBeVisible({ timeout: 30_000 });
  await dragRowTo(page, rowOf(page, "away-7"), paneOf(page, t5 ?? ""), 0.92, 0.5);
  await expect(chip(page)).toHaveText("away-7");
  await expect(overlay(page)).toHaveCount(0);
  await page.mouse.up();
  expect({ a: savedTab("tb-sa"), b: savedTab("tb-sb") }).toEqual(before);
  hcOn("machine", ["kill", away]);

  // The middle: the two trade places, each keeping its tab.
  await dragRowTo(page, rowOf(page, "swap-6"), paneOf(page, t5 ?? ""), 0.5, 0.5);
  await page.mouse.up();
  await expect.poll(() => savedTab("tb-sa"), { timeout: 15_000 }).toBe("tb-sa(p-tb-sa-1,p-tb-sb-1)");
  await expect.poll(() => savedTab("tb-sb")).toBe("tb-sb(p-tb-sa-2)");

  // A plain click on a row is still a click: it shows that agent, now in the other tab.
  await rowOf(page, "swap-5").click();
  await expect(paneOf(page, t5 ?? "")).toHaveAttribute("data-focused", "true", { timeout: 15_000 });
});

/** Past the 300 ms hold that lifts a row under a finger. */
const TOUCH_LIFT_MS = 350;

/**
 * One finger through CDP on a paused page clock, so only the test decides when the hold has lasted: pressed on `from`,
 * held past the lift or not, moved to `to`, then lifted. As machine-order-touch.e2e.ts does it.
 */
const touchPoint = (x: number, y: number) => [{ x, y }];

async function touchDrag(
  page: Page,
  from: Locator,
  to: { readonly x: number; readonly y: number },
  hold: boolean,
): Promise<void> {
  const start = await centreOf(from);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 5_000);
  const cdp = await page.context().newCDPSession(page);
  const t0 = Date.now() / 1000;
  const stamp = (ms: number) => t0 + ms / 1000;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: touchPoint(start.x, start.y),
    timestamp: stamp(0),
  });
  if (hold) {
    await page.clock.runFor(TOUCH_LIFT_MS);
    await expect(chip(page)).toHaveCount(1);
  }
  const movesFrom = hold ? TOUCH_LIFT_MS : 0;
  // One move at a time, in order, as a finger sends them.
  await Array.from({ length: 16 }, (_unused, index) => index + 1).reduce<Promise<unknown>>(
    (previous, step) =>
      previous.then(() =>
        cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: touchPoint(start.x + ((to.x - start.x) * step) / 16, start.y + ((to.y - start.y) * step) / 16),
          timestamp: stamp(movesFrom + step * 8),
        }),
      ),
    Promise.resolve(),
  );
  if (hold) await expect(overlay(page)).toHaveAttribute("data-pane-drop", "bottom");
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
    timestamp: stamp(movesFrom + 17 * 8),
  });
  await cdp.detach();
  await page.clock.resume();
}

test.describe("touch", () => {
  test.use({ hasTouch: true });

  test("a quick swipe on a row drags nothing; a held row dragged onto a pane's bottom edge becomes a pane there", async ({
    page,
  }) => {
    await page.clock.install();
    const [t8, t9, t10] = ["touch-8", "touch-9", "touch-10"].map((name) => shell(name));
    seedTwoTabs("tb-ta", "tb-tb", [t8 ?? "", t9 ?? "", t10 ?? ""]);
    await page.goto("/");
    await expect(paneOf(page, t8 ?? "")).toBeVisible({ timeout: 15_000 });
    await expect(rowOf(page, "touch-10")).toBeVisible({ timeout: 15_000 });
    const pane = await paneOf(page, t8 ?? "").boundingBox();
    if (pane === null) throw new Error("no pane box");
    const bottom = { x: pane.x + pane.width / 2, y: pane.y + pane.height * 0.92 };
    const before = { a: savedTab("tb-ta"), b: savedTab("tb-tb") };

    await touchDrag(page, rowOf(page, "touch-10"), bottom, false);
    await expect(chip(page)).toHaveCount(0);
    expect({ a: savedTab("tb-ta"), b: savedTab("tb-tb") }).toEqual(before);

    await touchDrag(page, rowOf(page, "touch-10"), bottom, true);
    await expect
      .poll(() => savedTab("tb-ta"), { timeout: 15_000 })
      .toMatch(/^tb-ta\(.*p-tb-ta-1.*p-tb-tb-1.*p-tb-ta-2.*\)$/);
    expect(savedTab("tb-tb")).toBeNull();
    const [above, below] = [await fractionOf(page, t8 ?? ""), await fractionOf(page, t10 ?? "")];
    expect(below.y).toBeGreaterThan(above.y);
  });
});
