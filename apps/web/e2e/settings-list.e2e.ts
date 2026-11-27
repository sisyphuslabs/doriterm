// The phone's list of Settings sections (#2914, before it the tab strip of #892): every label is drawn whole and on top,
// every row takes a 44 pt tap, and a keyboard-focused row's ring is drawn whole inside its card.
import { devices, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { openSettingsSection } from "./settings-sections.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use(phone);

interface Rows {
  readonly labels: readonly string[];
  /** Label points another element draws over, as `<label>@<x>: <element>`. */
  readonly occluded: readonly string[];
  /** Labels not wholly inside their row, or their row not wholly inside the screen. */
  readonly clipped: readonly string[];
  /** Each row's box, as `<label> <width>x<height>`. */
  readonly sizes: readonly string[];
}

const rows = (page: Page): Promise<Rows> =>
  page.locator("[data-settings-list]").evaluate((list) => {
    const occluded: string[] = [];
    const clipped: string[] = [];
    const sizes: string[] = [];
    const labels: string[] = [];
    for (const row of list.querySelectorAll("button")) {
      const name = row.textContent ?? "";
      labels.push(name);
      const box = row.getBoundingClientRect();
      sizes.push(`${name} ${Math.round(box.width)}x${Math.round(box.height)}`);
      const range = document.createRange();
      range.selectNodeContents(row);
      const label = range.getBoundingClientRect();
      if (label.left < box.left - 0.5 || label.right > box.right + 0.5 || box.left < 0 || box.right > innerWidth + 0.5)
        clipped.push(name);
      const y = box.top + box.height / 2;
      for (let x = box.left + 1; x < box.right - 1; x += 4) {
        const hit = document.elementFromPoint(x, y);
        if (hit === null || !row.contains(hit)) occluded.push(`${name}@${Math.round(x)}: ${hit?.tagName}`);
      }
    }
    return { labels, occluded, clipped, sizes };
  });

for (const width of [390, 320]) {
  test(`at ${width}, every section's row is drawn whole, on top, under its group (#2914)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/settings");
    await expect(page.locator("[data-settings-list]").getByRole("button", { name: "This device" })).toBeVisible();
    const drawn = await rows(page);
    expect(drawn.labels).toEqual([
      "This device",
      "Machines",
      "Appearance",
      "Terminal",
      "Keyboard",
      "Keybindings",
      "Voice input",
      "Notifications",
    ]);
    expect(drawn.clipped).toEqual([]);
    // The rows below the screen's edge are covered by nothing but the screen: only those in view are hit-tested.
    expect(drawn.occluded.filter((entry) => !/: (HTML|undefined)$/.test(entry))).toEqual([]);
  });
}

test("each section's row takes a 44 pt tap on a phone (#892)", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.locator("[data-settings-list]").getByRole("button").first()).toBeVisible();
  for (const size of (await rows(page)).sizes) {
    const [w, h] = (size.split(" ").at(-1) ?? "0x0").split("x").map(Number);
    expect(w, size).toBeGreaterThanOrEqual(44);
    expect(h, size).toBeGreaterThanOrEqual(44);
  }
});

test("a keyboard-focused row's ring is drawn whole, inside its card", async ({ page }) => {
  await page.goto("/settings");
  const list = page.locator("[data-settings-list]");
  await list.getByRole("button", { name: "This device" }).focus();
  await page.keyboard.press("Tab");
  const focused = list.getByRole("button", { name: "Machines" });
  await expect(focused).toBeFocused();
  const ring = await focused.evaluate((element) => {
    const style = getComputedStyle(element);
    const reach = Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth);
    const own = element.getBoundingClientRect();
    const box = element.closest("[data-settings-card]")?.getBoundingClientRect();
    return {
      style: style.outlineStyle,
      top: box === undefined ? -1 : own.top - reach - box.top,
      bottom: box === undefined ? -1 : box.bottom - (own.bottom + reach),
    };
  });
  expect(ring.style).toBe("solid");
  expect(ring.top).toBeGreaterThanOrEqual(0);
  expect(ring.bottom).toBeGreaterThanOrEqual(0);
});

test("a section opened from the list comes back to the list, which keeps every section", async ({ page }) => {
  await page.goto("/settings");
  await openSettingsSection(page, "Keybindings");
  await expect(page.getByRole("heading", { name: "Keybindings", level: 1 })).toBeVisible();
  await expect(page.locator("[data-settings-list]")).toHaveCount(0);
  await openSettingsSection(page, "Voice input");
  await expect(page.getByRole("heading", { name: "Voice input", level: 1 })).toBeVisible();
});

test("a section page's Back lines its chevron up with the title's left edge (#2914 review)", async ({ page }) => {
  await page.goto("/settings#terminal");
  const title = page.getByRole("heading", { name: "Terminal", level: 1 });
  await expect(title).toBeVisible();
  const chevron = page.getByRole("button", { name: "Settings", exact: true }).locator("svg");
  const [mark, heading] = await Promise.all([chevron.boundingBox(), title.boundingBox()]);
  expect(mark, "the chevron is drawn").not.toBeNull();
  expect(Math.abs((mark?.x ?? 0) - (heading?.x ?? 0))).toBeLessThanOrEqual(2);
});
