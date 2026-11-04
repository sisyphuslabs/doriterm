import { devices, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

/** The height of the sidebar's machine rows (the section's own rows, not its header). */
const rowHeight = (page: Page) =>
  page
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("region", { name: "Machines" })
    .evaluate((section) => {
      const rows = [...section.querySelectorAll(":scope > div")].map((row) => row.getBoundingClientRect().height);
      return rows.length === 0 ? 0 : Math.max(...rows);
    });

const openAppearance = (page: Page) =>
  page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Appearance" }).click();

async function choose(page: Page, density: "Compact" | "Comfortable" | "Spacious"): Promise<void> {
  await page.goto("/settings");
  await openAppearance(page);
  await page.getByLabel("Density").getByRole("button", { name: density }).click();
  await expect(page.getByLabel("Density").getByRole("button", { name: density })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

test("the sidebar starts at the comfortable row height", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => rowHeight(page), { timeout: 20_000 }).toBe(30);
});

for (const [density, height] of [
  ["Compact", 26],
  ["Spacious", 36],
  ["Comfortable", 30],
] as const) {
  test(`${density} sets the sidebar's rows to ${height} px and survives a reload`, async ({ page }) => {
    await choose(page, density);
    await page.reload();
    await openAppearance(page);
    await expect(page.getByLabel("Density").getByRole("button", { name: density })).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 20_000 },
    );
    await page.goto("/");
    await expect.poll(() => rowHeight(page), { timeout: 20_000 }).toBe(height);
  });
}

test("density leaves the terminal font alone", async ({ page }) => {
  await page.goto("/");
  const size = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--term-font-size"));
  const before = await size();
  await choose(page, "Compact");
  await page.goto("/");
  expect(await size()).toBe(before);
});

/** The height a row token resolves to on this page: an element sized by --row, measured. */
const tokenRow = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.height = "var(--row)";
    document.body.append(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return height;
  });

test.describe("touch", () => {
  const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
  test.use(phone);

  for (const [density, height] of [
    ["Compact", 44],
    ["Comfortable", 44],
    ["Spacious", 48],
  ] as const) {
    test(`${density} keeps touch rows at ${height} px, never under the 44 px target`, async ({ page }) => {
      await page.goto("/settings");
      await page.getByRole("tab", { name: "Appearance" }).click();
      await page.getByLabel("Density").getByRole("button", { name: density }).click();
      await expect(page.getByLabel("Density").getByRole("button", { name: density })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      expect(await tokenRow(page)).toBe(height);
    });
  }
});
