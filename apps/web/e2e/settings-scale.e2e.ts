import { devices, type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// Settings draws one scale in every section (#2878): one header size, one size for row titles and one for their second
// lines, rows at least 48 px, and one height for the buttons in rows, so moving between sections never resizes the screen.
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

const ROW_FLOOR = 48;

interface Scale {
  readonly headers: readonly number[];
  readonly titles: readonly number[];
  readonly details: readonly number[];
  readonly controls: readonly number[];
  readonly short: readonly string[];
}

/** The sizes each role is drawn in, as the eye reads them: the font size of the text itself, not of its wrapper. */
async function measure(scope: Locator): Promise<Scale> {
  return scope.evaluate((root, floor) => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function as source, so its helpers live inside it
    const shown = (el: Element): boolean => {
      const box = el.getBoundingClientRect();
      return box.width > 1 && box.height > 1 && !el.closest(".sr-only") && getComputedStyle(el).visibility !== "hidden";
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
    const headers = new Set<number>();
    for (const heading of root.querySelectorAll("h1, h2")) if (shown(heading)) drawnIn(heading, headers, BADGES);
    const titles = new Set<number>();
    const details = new Set<number>();
    const controls = new Set<number>();
    const short: string[] = [];
    for (const row of root.querySelectorAll("[data-setting-row]")) {
      if (!shown(row)) continue;
      const [title, ...lines] = [...(row.firstElementChild?.children ?? [])];
      if (title !== undefined) drawnIn(title, titles, BADGES);
      for (const line of lines) drawnIn(line, details, CAPTIONS);
      const height = row.getBoundingClientRect().height;
      if (height < floor) short.push(`${title?.textContent?.trim() ?? "?"}: ${height}px`);
      const slot = row.children.length > 1 ? row.lastElementChild : null;
      for (const button of slot?.querySelectorAll("button") ?? []) {
        const labelled = (button.textContent?.trim() ?? "") !== "";
        if (labelled && shown(button) && button.getAttribute("role") !== "switch" && !button.closest("[role=group]"))
          controls.add(Math.round(button.getBoundingClientRect().height));
      }
    }
    return { headers: [...headers], titles: [...titles], details: [...details], controls: [...controls], short };
  }, ROW_FLOOR);
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
        await settings
          .getByRole(width === 390 ? "tab" : "button", { name: section, exact: true })
          .first()
          .click();
        await expect(settings.locator('[data-slot="settings-body"]')).toBeVisible();
        const scale = await measure(settings);
        const said = JSON.stringify(scale);
        expect(scale.headers, `the screen title and the section titles are one size: ${said}`).toHaveLength(1);
        expect(scale.titles.length, `row titles are one size: ${said}`).toBeLessThanOrEqual(1);
        expect(scale.details.length, `row descriptions are one size: ${said}`).toBeLessThanOrEqual(1);
        expect(scale.controls.length, `buttons in rows are one height: ${said}`).toBeLessThanOrEqual(1);
        expect(scale.short, `every row is at least ${ROW_FLOOR} px`).toEqual([]);
      });
    }
  });
}
