import { startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { fold } from "./fold.ts";
import { seedLayout } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";

// CSS px from the makers' specs: Galaxy Z Fold7 (cover 1080 x 2520, inner 1968 x 2184, DPR 2.625) and iPhone Duo
// (outer 1398 x 2034, inner 1878 x 2670, 3x). Folded is the phone shell; open is the tablet's (a rail and the panes).
const DEVICES = [
  { name: "Galaxy Z Fold7", folded: { width: 412, height: 960 }, open: { width: 750, height: 832 } },
  { name: "iPhone Duo", folded: { width: 466, height: 678 }, open: { width: 626, height: 890 } },
] as const;

test.use({ serviceWorkers: "block", hasTouch: true, isMobile: true });

const shells: string[] = [];
test.afterEach(() => {
  for (const address of shells.splice(0)) hcOn("host", ["kill", address]);
});

for (const device of DEVICES) {
  test(`${device.name}: unfolding and folding keeps the open terminal and its output`, async ({ page }) => {
    const address = startShell("host", `fold-${device.folded.width}`);
    shells.push(address);
    seedLayout([{ id: "tb-fold", root: [{ pane: "pf", terminal: address, weight: 1 }] }]);
    await fold(page, device.folded);
    await page.goto("/");
    await page
      .getByRole("button", { name: new RegExp(`fold-${device.folded.width}`) })
      .first()
      .click();
    const terminal = page.locator(`[data-terminal="${address}"]:visible`);
    await expect(terminal).toContainText("$", { timeout: 20_000 });
    await terminal.getByRole("textbox").focus();
    await page.keyboard.type("echo folded-$((6*7))");
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText("folded-42", { timeout: 15_000 });

    // Open: the tablet shell, its sidebar a rail, the same terminal in view with what it printed.
    await fold(page, device.open);
    await expect(page.locator("aside[data-rail]")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Back to agents" })).toHaveCount(0);
    await expect(terminal).toBeVisible({ timeout: 15_000 });
    await expect(terminal).toContainText("folded-42", { timeout: 15_000 });

    // Folded again: the phone shell, still on that terminal.
    await fold(page, device.folded);
    await expect(page.locator("aside[data-rail]")).toHaveCount(0, { timeout: 15_000 });
    await expect(terminal).toBeVisible({ timeout: 15_000 });
    await expect(terminal).toContainText("folded-42", { timeout: 15_000 });
  });
}

test("an iPad in portrait shows the rail, 64 px, and stacks a side-by-side split top to bottom", async ({ page }) => {
  const [left, right] = [startShell("host", "ipad-left"), startShell("host", "ipad-right")];
  shells.push(left, right);
  seedLayout([
    {
      id: "tb-ipad",
      root: [
        { pane: "il", terminal: left, weight: 0.5 },
        { pane: "ir", terminal: right, weight: 0.5 },
      ],
    },
  ]);
  await fold(page, { width: 834, height: 1194 });
  await page.goto("/");
  const rail = page.locator("aside[data-rail]");
  await expect(rail).toBeVisible({ timeout: 20_000 });
  expect((await rail.boundingBox())?.width).toBe(64);
  const [one, two] = [page.locator(`[data-terminal="${left}"]`), page.locator(`[data-terminal="${right}"]`)];
  await expect(one).toBeVisible({ timeout: 20_000 });
  await expect(two).toBeVisible({ timeout: 20_000 });
  const [upper, lower] = [await one.boundingBox(), await two.boundingBox()];
  if (upper === null || lower === null) throw new Error("both panes laid out");
  expect(upper.y + upper.height).toBeLessThan(lower.y);

  // Turned to landscape (1194 wide) it is the desktop shell as it was: the split side by side again.
  await fold(page, { width: 1194, height: 834 });
  await expect(rail).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(async () => {
      const [a, b] = [await one.boundingBox(), await two.boundingBox()];
      return a !== null && b !== null && a.x + a.width < b.x;
    })
    .toBe(true);
});

test("on a dual-screen hinge a two-pane split puts each pane on its own side of the fold", async ({ page }) => {
  const [left, right] = [startShell("host", "hinge-left"), startShell("host", "hinge-right")];
  shells.push(left, right);
  seedLayout([
    {
      id: "tb-hinge",
      root: [
        { pane: "hl", terminal: left, weight: 0.7 },
        { pane: "hr", terminal: right, weight: 0.3 },
      ],
    },
  ]);
  // A Surface Duo class device spanned: two 540 px screens either side of a 34 px hinge. Headless Chromium reports one
  // segment whatever display feature CDP sets, so the page sees the segments a spanned browser reports
  // (window.viewport.segments), and a fold arrives as the resize it is.
  await page.setViewportSize({ width: 1114, height: 720 });
  await page.addInitScript(() => {
    const segments = [new DOMRect(0, 0, 540, 720), new DOMRect(574, 0, 540, 720)];
    Object.defineProperty(window, "viewport", { configurable: true, value: { segments } });
  });
  await page.goto("/");
  const [one, two] = [page.locator(`[data-terminal="${left}"]`), page.locator(`[data-terminal="${right}"]`)];
  await expect(one).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => {
      const [a, b] = [await one.boundingBox(), await two.boundingBox()];
      return a !== null && b !== null && a.x + a.width <= 540 && b.x >= 574;
    })
    .toBe(true);
});
