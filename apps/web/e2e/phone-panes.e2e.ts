import type { Page } from "@playwright/test";
import { startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { seedLayout } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { key } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const shells: string[] = [];
test.afterEach(() => {
  for (const address of shells.splice(0)) hcOn("host", ["kill", address]);
});

/** A split tab of these shells, opened on the phone by its first pane's row. */
async function openSplit(page: Page, names: readonly string[]): Promise<string[]> {
  const addresses = names.map((name) => startShell("host", name));
  shells.push(...addresses);
  seedLayout([
    {
      id: "tb-phone",
      root: addresses.map((terminal, index) => ({ pane: `p${index}`, terminal, weight: 1 / addresses.length })),
    },
  ]);
  await page.goto("/");
  await page
    .getByRole("button", { name: new RegExp(names[0] ?? "") })
    .first()
    .click();
  return addresses;
}

const half = (page: Page, address: string) => page.locator(`[data-split-half="${address}"]`);
const box = async (page: Page, address: string) => {
  const found = await half(page, address).boundingBox();
  if (found === null) throw new Error(`no half for ${address}`);
  return found;
};

test("a split tab opens as split focus: both terminals stacked, one tap moves the focus and the keys go with it", async ({
  page,
}) => {
  const [top, bottom] = await openSplit(page, ["focus-top", "focus-bottom"]);
  if (top === undefined || bottom === undefined) throw new Error("two shells");
  await expect(page.locator("[data-split-focus='stacked']")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-terminal]:visible")).toHaveCount(2, { timeout: 20_000 });
  await expect(half(page, top)).toHaveAttribute("data-focused", "true");
  await expect(half(page, bottom)).toHaveAttribute("data-focused", "false");
  const [upper, lower] = [await box(page, top), await box(page, bottom)];
  expect(upper.y + upper.height).toBeLessThanOrEqual(lower.y);
  expect(Math.abs(upper.x - lower.x)).toBeLessThan(1);
  // 55:45 by default.
  expect(upper.height).toBeGreaterThan(lower.height);
  await expect(page.getByRole("navigation", { name: "Panes in this tab" })).toHaveCount(0);

  // One tap on the lower half: it takes the focus, both stay mounted, and the keyboard types into it.
  await half(page, bottom).locator("[data-terminal]").tap();
  await expect(half(page, bottom)).toHaveAttribute("data-focused", "true");
  await expect(half(page, top)).toHaveAttribute("data-focused", "false");
  await expect(page.locator("[data-terminal]:visible")).toHaveCount(2);
  await key(page, "Show keyboard").click();
  await page.keyboard.type("echo typed-$((40+2))");
  await page.keyboard.press("Enter");
  await expect(half(page, bottom).locator("[data-terminal]")).toContainText("typed-42", { timeout: 15_000 });
  await expect(half(page, top).locator("[data-terminal]")).not.toContainText("typed-42");
});

test("in landscape the halves sit side by side", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  const [left, right] = await openSplit(page, ["beside-left", "beside-right"]);
  if (left === undefined || right === undefined) throw new Error("two shells");
  await expect(page.locator("[data-split-focus='beside']")).toBeVisible({ timeout: 20_000 });
  const [one, two] = [await box(page, left), await box(page, right)];
  expect(one.x + one.width).toBeLessThanOrEqual(two.x);
  expect(Math.abs(one.y - two.y)).toBeLessThan(1);
});

test("a half fills the screen with its expand button, and Back returns to the split", async ({ page }) => {
  const [first, second] = await openSplit(page, ["fill-one", "fill-two"]);
  if (first === undefined || second === undefined) throw new Error("two shells");
  await expect(page.locator("[data-split-focus]")).toBeVisible({ timeout: 20_000 });
  await half(page, second)
    .getByRole("button", { name: /^Fill the screen with / })
    .click();
  await expect(page.locator("[data-split-focus]")).toHaveCount(0);
  await expect(page.locator("[data-terminal]:visible")).toHaveCount(1);
  await expect(page.locator("[data-terminal]:visible")).toHaveAttribute("data-terminal", second, { timeout: 15_000 });
  await page.getByRole("button", { name: "Back to Split" }).click();
  await expect(page.locator("[data-split-focus]")).toBeVisible();
  await expect(half(page, second)).toHaveAttribute("data-focused", "true");
});

test("past two panes the split shows the focused one and the one before it, and the switcher reaches the rest", async ({
  page,
}) => {
  const [a, b, c] = await openSplit(page, ["three-a", "three-b", "three-c"]);
  if (a === undefined || b === undefined || c === undefined) throw new Error("three shells");
  await expect(page.locator("[data-split-half]")).toHaveCount(2, { timeout: 20_000 });
  await expect(half(page, a)).toBeVisible();
  await expect(half(page, b)).toBeVisible();
  const panes = page.getByRole("navigation", { name: "Panes in this tab" });
  await panes.getByRole("button", { name: "Next pane" }).click();
  await panes.getByRole("button", { name: "Next pane" }).click();
  await expect(half(page, c)).toHaveAttribute("data-focused", "true", { timeout: 15_000 });
  await expect(half(page, b)).toBeVisible();
  await expect(half(page, a)).toHaveCount(0);
});
