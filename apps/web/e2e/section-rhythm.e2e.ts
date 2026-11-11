// The sidebar's sections and the phone palette's groups read as groups (#1496): a heading sits closer to what it names
// than to what came before it, the space between groups is at least twice the space between lines inside one, and an
// agent section's heading starts on the label column of its rows.
import type { Page } from "@playwright/test";
import { endAgent, startAgent, startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { sectionRhythm, sectionTitleAlignments } from "./section-rhythm.ts";

test.use({ serviceWorkers: "block" });

let started: string[] = [];
test.beforeEach(() => {
  started = [
    startAgent("host", "deploy", "blocked", "website"),
    startAgent("host", "review", "working", "doriface"),
    startShell("host", "shell"),
    startAgent("host", "tests", "done", "website"),
  ];
});
test.afterEach(() => {
  for (const address of started) endAgent("host", address);
});

async function expectRhythm(page: Page) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  const rhythm = await page.evaluate(sectionRhythm);
  expect(rhythm.headings.length + rhythm.groups.length, "the screen has headings or groups to measure").toBeGreaterThan(
    0,
  );
  for (const heading of rhythm.headings) {
    const label = `heading "${heading.name}": ${heading.above} above, ${heading.below} below`;
    if (heading.below > 0) expect.soft(heading.above / heading.below, label).toBeGreaterThanOrEqual(1.5);
  }
  for (const group of rhythm.groups) {
    const label = `group "${group.name}": ${group.inter} between, ${group.intra.join("/")} inside`;
    for (const gap of group.intra) expect.soft(group.inter / gap, label).toBeGreaterThanOrEqual(2);
  }
}

/** Each sidebar section's title, Spaces included, starts on the label column of the first row it heads (#1496, #1612). */
async function expectTitlesAlignedWithRows(page: Page) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  const sections = await page.evaluate(sectionTitleAlignments);
  const names = sections.map((section) => section.name);
  for (const title of ["Agents", "Needs you", "Working", "Idle", "Done"])
    expect(names, `the sidebar has a "${title}" section`).toContain(title);
  expect(names, 'the sidebar has a "Spaces" section').toContain("Spaces");
  for (const section of sections) {
    const label = `section "${section.name}": title at ${section.title}, first row's label at ${section.row}`;
    expect.soft(section.row, label).not.toBeNull();
    if (section.row !== null) expect.soft(Math.abs(section.title - section.row), label).toBeLessThanOrEqual(1);
  }
}

for (const theme of ["day", "night"] as const) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme === "day" ? "light" : "dark" });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((chosen) => {
        localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] }));
      }, theme);
    });

    test.describe("1440", () => {
      test.use({ viewport: { width: 1440, height: 900 } });
      test("the sidebar's spaces and agent sections keep the section rhythm", async ({ page }) => {
        await page.goto("/");
        await Promise.all(
          ["Needs you", "Working", "Idle", "Done"].map((title) =>
            expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible({ timeout: 15_000 }),
          ),
        );
        await expectRhythm(page);
        await expectTitlesAlignedWithRows(page);
      });
    });

    test.describe("390", () => {
      test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
      test("the command palette's groups keep the section rhythm", async ({ page }) => {
        await page.goto("/");
        await expect(page.getByText("Needs you").first()).toBeVisible({ timeout: 15_000 });
        await page.getByRole("button", { name: "Command palette" }).first().click();
        await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
        await expect(page.getByRole("group").first()).toBeVisible();
        await expectRhythm(page);
      });
    });
  });
}
