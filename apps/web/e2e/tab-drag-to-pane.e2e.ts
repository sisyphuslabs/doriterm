import type { Locator, Page } from "@playwright/test";
import { startShell } from "./agents.ts";
import { getCoreDoc } from "./core-doc.ts";
import { expect, test } from "./fixtures.ts";
import { fractionOf, LAYOUT_DOC, paneOf, savedTab, seedLayout } from "./layout-doc.ts";

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });

const point = (x: number, y: number) => [{ x, y }];

async function pressAndMove(page: Page, from: Locator, to: Locator, x: number, y: number): Promise<void> {
  const [source, target] = await Promise.all([from.boundingBox(), to.boundingBox()]);
  if (source === null || target === null) throw new Error("missing drag source or destination");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width * x, target.y + target.height * y, { steps: 24 });
}

test("the phone terminal header is not a pane drag source", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const header = page.getByRole("banner");
  await header.getByRole("button", { name: "New tab" }).click();
  const terminal = page.locator("[data-terminal]:visible");
  await expect(terminal).toContainText("$");
  await expect(header.locator("[data-tab-id]:visible, [data-pane-grab]:visible")).toHaveCount(0);
  await pressAndMove(page, header.getByRole("heading").first(), terminal, 0.92, 0.5);
  await expect(page.locator("[data-terminal-drag], [data-pane-drop]")).toHaveCount(0);
  await page.mouse.up();
  await expect(terminal).toBeVisible();
});

for (const [edge, x, y] of [
  ["left", 0.08, 0.5],
  ["right", 0.92, 0.5],
  ["top", 0.5, 0.08],
  ["bottom", 0.5, 0.92],
] as const) {
  test(`a top tab becomes the ${edge} pane and its terminal can return to the strip`, async ({ page }) => {
    const editor = startShell("host", "editor");
    const build = startShell("host", "build");
    seedLayout([
      { id: "tb-editor", name: "Editor", root: [{ pane: "p-editor", terminal: editor }] },
      { id: "tb-build", name: "Build", root: [{ pane: "p-build", terminal: build }] },
    ]);
    await page.goto("/");
    const original = paneOf(page, editor);
    const moved = paneOf(page, build);
    await expect(original).toBeVisible();
    await pressAndMove(page, page.locator('[data-tab-id="tb-build"]:visible'), original, x, y);
    await expect(page.locator("[data-pane-drop]")).toHaveAttribute("data-pane-drop", edge);
    await page.mouse.up();
    await expect.poll(() => savedTab("tb-build")).toBeNull();
    await expect(moved).toBeVisible();
    const [a, b] = await Promise.all([fractionOf(page, editor), fractionOf(page, build)]);
    if (edge === "left") expect(b.x).toBeLessThan(a.x);
    if (edge === "right") expect(b.x).toBeGreaterThan(a.x);
    if (edge === "top") expect(b.y).toBeLessThan(a.y);
    if (edge === "bottom") expect(b.y).toBeGreaterThan(a.y);

    const strip = page.getByRole("tablist").filter({ visible: true });
    await pressAndMove(page, moved.locator("header h2"), strip, 0.8, 0.5);
    await page.mouse.up();
    // Splitting and removing a sibling can normalize the survivor's size to weight 1.
    // Check the exact number/order of tabs and panes and their terminal addresses, not that incidental encoding.
    await expect
      .poll(() => getCoreDoc(LAYOUT_DOC))
      .toMatchObject({
        spaces: [
          {
            tabs: [
              { id: "tb-editor", root: { children: [{ id: "p-editor", content: { terminal: editor } }] } },
              { root: { children: [{ id: "p-build", content: { terminal: build } }] } },
            ],
          },
        ],
      });
    const newTab = strip.locator('[data-tab-id]:not([data-tab-id="tb-editor"])');
    await expect(newTab).toHaveCount(1);
    await newTab.click();
    await expect(moved).toBeVisible();
  });
}

test("Escape cancels a top-tab drop preview without moving or selecting its terminal", async ({ page }) => {
  const editor = startShell("host", "editor");
  const build = startShell("host", "build");
  seedLayout([
    { id: "tb-editor", name: "Editor", root: [{ pane: "p-editor", terminal: editor }] },
    { id: "tb-build", name: "Build", root: [{ pane: "p-build", terminal: build }] },
  ]);
  await page.goto("/");
  const original = paneOf(page, editor);
  await expect(original).toBeVisible();
  const source = page.locator('[data-tab-id="tb-build"]:visible');
  await pressAndMove(page, source, original, 0.5, 0.5);
  await expect(page.locator("[data-pane-drop]")).toHaveAttribute("data-pane-drop", "swap");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator("[data-pane-drop], [data-terminal-drag]")).toHaveCount(0);
  await expect(original).toBeVisible();
  expect(savedTab("tb-build")).toBe("tb-build(p-build)");
  expect(savedTab("tb-editor")).toBe("tb-editor(p-editor)");
  await source.click();
  await expect(paneOf(page, build)).toBeVisible();
  // A real center drop trades the terminals, not their running sessions or the strip positions.
  await pressAndMove(page, page.locator('[data-tab-id="tb-editor"]:visible'), paneOf(page, build), 0.5, 0.5);
  await expect(page.locator("[data-pane-drop]")).toHaveAttribute("data-pane-drop", "swap");
  await page.mouse.up();
  await expect.poll(() => savedTab("tb-build")).toBe("tb-build(p-editor)");
  await expect.poll(() => savedTab("tb-editor")).toBe("tb-editor(p-build)");
});

test.describe("tablet", () => {
  test.use({ hasTouch: true, viewport: { width: 1180, height: 820 } });

  test("a held tab lifts on touch and splits the visible pane", async ({ page }, info) => {
    const editor = startShell("host", "editor");
    const build = startShell("host", "build");
    seedLayout([
      { id: "tb-editor", name: "Editor", root: [{ pane: "p-editor", terminal: editor }] },
      { id: "tb-build", name: "Build", root: [{ pane: "p-build", terminal: build }] },
    ]);
    await page.clock.install();
    await page.goto("/");
    const original = paneOf(page, editor);
    await expect(original).toBeVisible();
    const from = await page.locator('[data-tab-id="tb-build"]:visible').boundingBox();
    const to = await original.boundingBox();
    if (from === null || to === null) throw new Error("missing tablet tab or pane");
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 5_000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: point(from.x + from.width / 2, from.y + from.height / 2),
    });
    await page.clock.runFor(350);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: point(to.x + to.width / 2, to.y + to.height * 0.92),
    });
    await expect(page.locator("[data-pane-drop]")).toHaveAttribute("data-pane-drop", "bottom");
    await page.screenshot({ path: info.outputPath("tablet-preview-1180.png") });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    await page.clock.resume();
    await expect.poll(() => savedTab("tb-build")).toBeNull();
    await expect(paneOf(page, build)).toBeVisible();
    expect((await fractionOf(page, build)).y).toBeGreaterThan((await fractionOf(page, editor)).y);
  });
});
