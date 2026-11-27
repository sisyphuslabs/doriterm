import { devices, type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { openSettingsSection } from "./settings-sections.ts";

// Settings draws one scale in every section (#2878, #2914): one title size, one caption size, one size for row titles
// and one for their second lines, rows at least --settings-row-min, and one height for the buttons in rows, so moving
// between sections never resizes the screen.
test.use({ serviceWorkers: "block" });

const SECTIONS = [
  "This device",
  "Machines",
  "Terminal",
  "Keyboard",
  "Notifications",
  "Appearance",
  "Keybindings",
  "Voice input",
] as const;

/** A `--settings-*` length as this page resolves it, in px (#2914: one token, a fine and a coarse value). */
const token = (page: Page, name: string): Promise<number> =>
  page.evaluate((property) => {
    const root = getComputedStyle(document.documentElement);
    return Number.parseFloat(root.getPropertyValue(property)) * Number.parseFloat(root.fontSize);
  }, name);

/** What Settings used before #2878 (`py-3.5`), which the scale may not grow past: Q asked for compact, as herdr-app is. */
const ROW_PADDING_CEILING = 14;

/** What a caption's own line may hold under it before its card: Settings' 8 px, never the 16 px of a block gap. */
const CAPTION_GAP_CEILING = 8;

interface Scale {
  readonly titles1: readonly number[];
  readonly captions: readonly number[];
  readonly titles: readonly number[];
  readonly details: readonly number[];
  readonly controls: readonly number[];
  readonly short: readonly string[];
  readonly padded: readonly string[];
}

/** The sizes each role is drawn in, as the eye reads them: the font size of the text itself, not of its wrapper. */
async function measure(scope: Locator, floor: number): Promise<Scale> {
  return scope.evaluate(
    (root, [rowFloor, ceiling]) => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function as source, so its helpers live inside it
      const shown = (el: Element): boolean => {
        const box = el.getBoundingClientRect();
        // A closed disclosure keeps its content's boxes in Chromium, so its content would count though nobody sees it.
        const closed = el.closest("details:not([open])");
        const folded = closed !== null && el.closest("summary")?.parentElement !== closed;
        return (
          box.width > 1 &&
          box.height > 1 &&
          !folded &&
          !el.closest(".sr-only") &&
          getComputedStyle(el).visibility !== "hidden"
        );
      };
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- as above
      const drawnIn = (el: Element, into: Set<number>, captions: string): void => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const parent = node.parentElement;
          if (parent === null || node.textContent?.trim() === "" || !shown(parent)) continue;
          if (parent.closest(captions) !== null) continue;
          into.add(Number.parseFloat(getComputedStyle(parent).fontSize));
        }
      };
      // Badges (Not applied) are chips, and the code in a description (ids, commands) is a caption: a step below on purpose.
      const BADGES = "[data-slot=badge]";
      const CAPTIONS = "[data-slot=badge], code, .font-mono";
      const titles1 = new Set<number>();
      for (const heading of root.querySelectorAll("h1")) if (shown(heading)) drawnIn(heading, titles1, BADGES);
      const captions = new Set<number>();
      for (const heading of root.querySelectorAll("h2, h3")) if (shown(heading)) drawnIn(heading, captions, BADGES);
      const titles = new Set<number>();
      const details = new Set<number>();
      const controls = new Set<number>();
      const short: string[] = [];
      const padded: string[] = [];
      for (const row of root.querySelectorAll("[data-setting-row]")) {
        if (!shown(row)) continue;
        const [title, ...lines] = [...(row.firstElementChild?.children ?? [])];
        if (title !== undefined) drawnIn(title, titles, BADGES);
        for (const line of lines) drawnIn(line, details, CAPTIONS);
        const height = row.getBoundingClientRect().height;
        if (height < rowFloor) short.push(`${title?.textContent?.trim() ?? "?"}: ${height}px`);
        const padding = Number.parseFloat(getComputedStyle(row).paddingTop);
        if (padding > ceiling) padded.push(`${title?.textContent?.trim() ?? "?"}: ${padding}px`);
        const slot = row.children.length > 1 ? row.lastElementChild : null;
        for (const button of slot?.querySelectorAll("button") ?? []) {
          const labelled = (button.textContent?.trim() ?? "") !== "";
          if (labelled && shown(button) && button.getAttribute("role") !== "switch" && !button.closest("[role=group]"))
            controls.add(Math.round(button.getBoundingClientRect().height));
        }
      }
      return {
        titles1: [...titles1],
        captions: [...captions],
        titles: [...titles],
        details: [...details],
        controls: [...controls],
        short,
        padded,
      };
    },
    [floor, ROW_PADDING_CEILING] as const,
  );
}

const settingsView = (page: Page) => page.getByRole("dialog", { name: "Settings" });

for (const width of [390, 1440] as const) {
  test.describe(`${width}`, () => {
    const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
    test.use(width === 390 ? phone : { viewport: { width: 1440, height: 900 } });

    for (const section of SECTIONS) {
      test(`Settings > ${section} draws one scale`, async ({ page }) => {
        await page.goto("/settings");
        const settings = settingsView(page);
        await openSettingsSection(page, section);
        await expect(settings.locator('[data-slot="settings-body"]')).toBeVisible();
        const floor = await token(page, "--settings-row-min");
        const scale = await measure(settings, floor);
        const said = JSON.stringify(scale);
        expect(scale.titles1, `the screen's title is one size: ${said}`).toHaveLength(1);
        // A phone page whose one group is named as the section draws no caption (its title says it, #2914).
        expect(scale.captions.length, `every caption (group and sub-group) is one size: ${said}`).toBeLessThanOrEqual(
          1,
        );
        expect(scale.titles.length, `row titles are one size: ${said}`).toBeLessThanOrEqual(1);
        expect(scale.details.length, `row descriptions are one size: ${said}`).toBeLessThanOrEqual(1);
        expect(scale.controls.length, `buttons in rows are one height: ${said}`).toBeLessThanOrEqual(1);
        expect(scale.short, `every row is at least ${floor} px`).toEqual([]);
        expect(scale.padded, `no row pads more than ${ROW_PADDING_CEILING} px`).toEqual([]);
      });
    }
  });
}

/** Each line of the section's search toolbar, as the number of controls drawn on it. */
async function toolbarLines(settings: Locator): Promise<number[]> {
  return settings.locator('[data-slot="settings-body"]').evaluate((body) => {
    const field = body.querySelector("input[type=search]");
    const bar = field?.parentElement?.parentElement;
    if (bar === null || bar === undefined) return [];
    const lines = new Map<number, number>();
    for (const control of bar.querySelectorAll("input, button")) {
      const box = control.getBoundingClientRect();
      if (box.width < 1) continue;
      const top = Math.round(box.top);
      lines.set(top, (lines.get(top) ?? 0) + 1);
    }
    return [...lines.entries()].toSorted((a, b) => a[0] - b[0]).map(([, count]) => count);
  });
}

for (const width of [390, 320] as const) {
  test.describe(`${width} phone`, () => {
    const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
    test.use({ ...phone, viewport: { width, height: 844 } });

    for (const section of ["Terminal", "Keybindings"] as const) {
      test(`Settings > ${section} leaves no toolbar control alone on a line`, async ({ page }) => {
        await page.goto(`/settings`);
        const settings = settingsView(page);
        await openSettingsSection(page, section);
        await expect(settings.getByRole("heading", { name: section, level: 1 })).toBeVisible();
        const lines = await toolbarLines(settings);
        expect(lines.length, "the toolbar is drawn").toBeGreaterThan(0);
        expect(Math.min(...lines), `controls per toolbar line: ${lines.join(", ")}`).toBeGreaterThan(1);
      });
    }
  });
}

test.describe("390x844 phone", () => {
  const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
  test.use({ ...phone, viewport: { width: 390, height: 844 } });

  for (const section of ["Terminal", "Keybindings"] as const) {
    test(`Settings > ${section} spaces its captions and blocks by the scale's tokens`, async ({ page }) => {
      await page.goto("/settings");
      const settings = settingsView(page);
      await openSettingsSection(page, section);
      await expect(settings.getByRole("heading", { name: section, level: 1 })).toBeVisible();
      const caption = settings.locator('[data-slot="settings-body"] h3').first();
      await expect(caption).toBeVisible();
      const titleGap = await caption.evaluate((heading) => Number.parseFloat(getComputedStyle(heading).paddingBottom));
      const groupGap = await token(page, "--settings-group-gap");
      const blockGap = await settings.locator('[data-slot="settings-body"] input[type=search]').evaluate((field) => {
        const stack = field.parentElement?.parentElement?.parentElement;
        return stack === null || stack === undefined ? Number.NaN : Number.parseFloat(getComputedStyle(stack).rowGap);
      });
      expect(titleGap, "space under a caption").toBeLessThanOrEqual(CAPTION_GAP_CEILING);
      expect(blockGap, "space between the section's blocks").toBe(groupGap);
    });
  }
});
