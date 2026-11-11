import { devices, type Locator, type Page } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";

// Every heading step in use differs by at least 1.25x, and the smallest heading from its body, on every screen (#1578).
test.use({ serviceWorkers: "block" });

const STEP = 1.25;

/**
 * The font sizes a scope draws, as the eye reads them: each heading level's size, and its body's (the size most of its
 * text is set in). Hidden text and the visually-hidden helpers do not count.
 */
async function scale(scope: Locator): Promise<{ readonly headings: number[]; readonly body: number }> {
  return scope.evaluate((root) => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function as source, so its helpers live inside it
    const shown = (el: Element): boolean => {
      const box = el.getBoundingClientRect();
      return box.width > 1 && box.height > 1 && !el.closest(".sr-only") && getComputedStyle(el).visibility !== "hidden";
    };
    const headings = new Set<number>();
    for (const el of root.querySelectorAll("h1, h2, h3, h4, [role=heading]"))
      if (shown(el)) headings.add(Number.parseFloat(getComputedStyle(el).fontSize));
    const counts = new Map<number, number>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      const text = node.textContent?.trim() ?? "";
      if (parent === null || text === "" || !shown(parent) || parent.closest("h1, h2, h3, h4, [role=heading]"))
        continue;
      const px = Number.parseFloat(getComputedStyle(parent).fontSize);
      counts.set(px, (counts.get(px) ?? 0) + text.length);
    }
    const body = [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    return { headings: [...headings].toSorted((a, b) => b - a), body };
  });
}

/** Each neighbouring pair of distinct sizes, the body among them, as `larger/smaller`, where one is under STEP. */
function tooClose({ headings, body }: { readonly headings: number[]; readonly body: number }): string[] {
  const sizes = [...new Set([...headings, body])].toSorted((a, b) => b - a);
  const close: string[] = [];
  for (let i = 1; i < sizes.length; i += 1) {
    const [larger, smaller] = [sizes[i - 1] ?? 0, sizes[i] ?? 0];
    if (larger / smaller < STEP) close.push(`${larger}/${smaller}=${(larger / smaller).toFixed(3)}`);
  }
  if (headings.includes(body)) close.push(`a heading is the body's ${body} px`);
  return close;
}

async function expectScale(scope: Locator): Promise<void> {
  const measured = await scale(scope);
  expect(measured.headings.length, "the scope draws headings").toBeGreaterThan(0);
  expect(tooClose(measured), JSON.stringify(measured)).toEqual([]);
}

const settingsDialog = (page: Page) => page.getByRole("dialog", { name: "Settings" });

for (const width of [390, 1440] as const) {
  test.describe(`${width}`, () => {
    const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
    test.use(width === 390 ? phone : { viewport: { width: 1440, height: 900 } });

    for (const section of ["Keybindings", "Terminal", "Notifications"] as const) {
      test(`Settings > ${section} keeps its heading steps apart`, async ({ page }) => {
        await page.goto("/settings");
        const settings = settingsDialog(page);
        await settings
          .getByRole(width === 390 ? "tab" : "button", { name: section, exact: true })
          .first()
          .click();
        await expect(settings.getByRole("heading", { name: section, level: 2 })).toBeVisible();
        await expectScale(settings);
      });
    }
  });
}

test("a dialog's title stands apart from its description", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const address = startAgent("host", "heading-scale-dialog", "idle", "heading-scale");
  try {
    await page.goto("/");
    const sidebar = page.getByRole("complementary", { name: "Workspace" });
    await sidebar.getByRole("button", { name: /^heading-scale(?: |$)/ }).hover({ timeout: 20_000 });
    await sidebar.getByRole("button", { name: "More for heading-scale" }).click();
    await page.getByRole("menuitem", { name: "Rename space\u2026" }).click();
    await expectScale(page.getByRole("dialog", { name: "Rename heading-scale" }));
  } finally {
    endAgent("host", address);
  }
});
