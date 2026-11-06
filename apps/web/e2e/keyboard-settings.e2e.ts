import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { fakeSoftKeyboard, PHONE, showKeyboard } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE });

const keysBar = (page: Page) => page.getByRole("toolbar", { name: "Terminal keys" });

/** The bar's keys in the order it draws them, as the names a screen reader hears. */
async function barNames(bar: Locator): Promise<readonly string[]> {
  return bar
    .locator("button")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""));
}

async function openSettings(page: Page): Promise<void> {
  await fakeSoftKeyboard(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("tab", { name: "Keyboard" }).click();
}

async function openTerminal(page: Page): Promise<Locator> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  const terminal = page.locator("[data-terminal]");
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  // The bar rides on the soft keyboard, which a headless browser has none of: raise the fake one, as a person's does.
  await showKeyboard(page, 336);
  await expect(keysBar(page)).toBeVisible();
  return terminal;
}

test("a pack added in Settings puts its keys in the bar, and the bar keeps that order after a reload", async ({
  page,
}) => {
  await openSettings(page);
  const preview = page.locator("[data-key-bar-preview]");
  await expect(preview.locator("[data-pack-tab]")).toHaveCount(0);

  const tmux = page.locator('[data-pack-row="tmux"]').getByRole("switch");
  await tmux.click();
  await expect(tmux).toHaveAttribute("aria-checked", "true");
  // The preview shows the row the list edits, and the pack it was given as a tab of its own, pressed because the bar leads
  // with it.
  await expect(preview.locator("[data-preview-key]")).toHaveCount(await page.locator("[data-key-row]").count());
  await expect(preview.getByRole("button", { name: "Tmux" })).toHaveAttribute("aria-pressed", "true");

  // The add form scrolled the body: bring the rows back into view before dragging one.
  await page.locator('[data-key-row="ctrl"]').scrollIntoViewIfNeeded();
  await expect(page.locator("[data-key-row]").first()).toHaveAttribute("data-key-row", "ctrl");
  const moving = await page.locator('[data-key-row="esc"]').boundingBox();
  const landing = await page.locator('[data-key-row="ctrl"]').boundingBox();
  if (moving === null || landing === null) throw new Error("the key rows were not drawn");
  await page.mouse.move(moving.x + 24, moving.y + moving.height / 2);
  await page.mouse.down();
  await page.mouse.move(landing.x + 24, landing.y - 6, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator("[data-key-row]").first()).toHaveAttribute("data-key-row", "esc");
  // The preview follows the drag: its first key is the one the list now puts first.
  await expect(preview.locator("[data-preview-key]").first()).toHaveAttribute("data-preview-key", "esc");

  const terminal = await openTerminal(page);
  const bar = keysBar(page);
  const names = await barNames(bar);
  expect(names.slice(0, 2)).toEqual(["Tmux prefix", "New window"]);
  // The drag's order is the bar's: Escape is now ahead of Control.
  expect(names.indexOf("Escape")).toBeGreaterThan(-1);
  expect(names.indexOf("Escape")).toBeLessThan(names.indexOf("Control"));
  await expect(terminal).toBeVisible();

  // The document is this device's: a reload keeps the order and the pack.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await page.goto("/settings");
  await page.getByRole("tab", { name: "Keyboard" }).click();
  await expect(page.locator("[data-key-row]").first()).toHaveAttribute("data-key-row", "esc");
});

test("a key of the person's own is checked, stored and sent by the bar", async ({ page }) => {
  await openSettings(page);
  await page.getByLabel("Key label").fill("Shout");
  await page.getByLabel("Keys it sends").fill("echo hello-from-a-key");
  await page.getByRole("button", { name: "Add key" }).click();
  await expect(page.locator("[data-favorite-row]")).toHaveCount(1);
  await expect(page.locator('[data-pack-tab="favorites"]')).toHaveAttribute("aria-pressed", "true");

  const terminal = await openTerminal(page);
  await page.getByRole("button", { name: "Shout", exact: true }).click();
  await expect(terminal).toContainText("hello-from-a-key", { timeout: 10_000 });
});

test("an entry that names no key is refused with a reason and stored nowhere", async ({ page }) => {
  await openSettings(page);
  await page.getByLabel("Key label").fill("Broken");
  await page.getByLabel("Keys it sends").fill("Ctrl+");
  await page.getByRole("button", { name: "Add key" }).click();
  await expect(page.getByText("End the key with what it presses, e.g. Ctrl+X.")).toBeVisible();
  await expect(page.locator("[data-favorite-row]")).toHaveCount(0);
});

test("a key removed from the bar is listed as not in it, and one tap puts it back", async ({ page }) => {
  await openSettings(page);
  const preview = page.locator("[data-key-bar-preview]");
  await expect(preview.locator('[data-preview-key="esc"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Remove Escape" }).click();
  await expect(preview.locator('[data-preview-key="esc"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Add Escape" }).click();
  await expect(preview.locator('[data-preview-key="esc"]')).toHaveCount(1);
});

const channels = (value: string): readonly number[] => value.match(/[\d.]+/g)?.map(Number) ?? [];

const linear = (value: number): number => {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
};

const luminance = (value: string): number => {
  const [r = 0, g = 0, b = 0] = channels(value);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};

const contrast = (a: string, b: string): number => {
  const [light = 0, dark = 0] = [luminance(a), luminance(b)].toSorted((left, right) => right - left);
  return (light + 0.05) / (dark + 0.05);
};

for (const theme of ["day", "night"] as const) {
  test(`the preview draws the bar's keys and they stay readable in the ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme === "day" ? "light" : "dark" });
    await page.addInitScript(
      (chosen: string) => localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] })),
      theme,
    );
    await openSettings(page);
    const pills = page.locator("[data-key-bar-preview] [data-preview-key]");
    await expect(pills.first()).toBeVisible();
    expect(await pills.count()).toBeGreaterThan(5);
    // Every key's ink against the surface it is drawn on: the theme's foreground cannot drop under 4.5:1 for these pills.
    // A paint failure (the edge-fade mask that once hid the old preview) is a different bug and is not what this measures.
    const surface = await pills
      .first()
      .evaluate((pill) => getComputedStyle(pill.parentElement ?? pill).backgroundColor);
    // rgb(r, g, b), never rgba(..., a) with a under 1: a transparent row would make the ratio meaningless.
    expect(surface).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    const colors = await pills.evaluateAll((all) => all.map((pill) => getComputedStyle(pill).color));
    expect(Math.min(...colors.map((color) => contrast(color, surface)))).toBeGreaterThanOrEqual(4.5);
  });
}

test("holding Ctrl opens the packs panel without latching it, while a tap still latches", async ({ page }) => {
  await openSettings(page);
  await page.locator('[data-pack-row="tmux"]').getByRole("switch").click();
  await openTerminal(page);
  const ctrl = page.getByRole("button", { name: "Control", exact: true });
  const press = { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0 };
  await ctrl.dispatchEvent("pointerdown", { ...press, buttons: 1 });
  const panel = page.getByRole("dialog", { name: "Shortcut packs" });
  await expect(panel).toBeVisible({ timeout: 3000 });
  // The page behind a modal is inert, so the bar is read again once the panel closes.
  await panel.getByRole("button", { name: "Done", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await ctrl.dispatchEvent("pointerup", { ...press, buttons: 0 });
  // The hold opened the panel; it did not latch the modifier the person was aiming at.
  await expect(ctrl).toHaveAttribute("aria-pressed", "false");
  await ctrl.click();
  await expect(ctrl).toHaveAttribute("aria-pressed", "true");
});
