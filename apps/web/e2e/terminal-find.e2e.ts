import type { Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const mac = process.platform === "darwin";
const FIND = mac ? "Meta+f" : "Control+Shift+F";

const findBar = (page: Page) => page.getByRole("search");
const field = (page: Page) => page.getByRole("searchbox", { name: "Find in terminal" });

test("the find chord finds a line only in the scrollback, steps, and Escape gives the program its keys back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  // One marked line, then enough output to push it far up into the scrollback.
  await page.keyboard.type("printf 'needle-%s\\n' 7 8; seq 1 400");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("400");
  const atBottom = await terminal.evaluate(
    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
  );
  expect(atBottom).toBeLessThan(5);

  await page.keyboard.press(FIND);
  await expect(field(page)).toBeFocused();
  await page.keyboard.type("needle-");
  // The typed command line holds the query too: the matches are that line and the two printed lines, and a new
  // query starts on the last one at or above the view's bottom.
  const status = findBar(page).getByRole("status");
  await expect(status).toHaveText("3 of 3");
  // Enter wraps from the last match to the first, Shift+Enter back.
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("1 of 3");
  await page.keyboard.press("Shift+Enter");
  await expect(status).toHaveText("3 of 3");
  await page.keyboard.press("Shift+Enter");
  await expect(status).toHaveText("2 of 3");
  await page.keyboard.type("7");
  await expect(status).toHaveText("1 of 1");

  // The current match is the printed line, scrolled into view from far up the scrollback.
  const current = page.locator('[data-find-match="current"]');
  await expect(current).toBeVisible();
  const away = await terminal.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  expect(away).toBeGreaterThan(100);
  const box = await terminal.boundingBox();
  const mark = await current.boundingBox();
  expect(box !== null && mark !== null && mark.y >= box.y && mark.y + mark.height <= box.y + box.height).toBe(true);

  await page.keyboard.press("Escape");
  await expect(findBar(page)).toHaveCount(0);
  await expect(page.locator("[data-find-match]")).toHaveCount(0);
  await page.keyboard.type("echo $((40 + 2))-done");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("42-done");

  // Reopened, the terminal's query is back and selected, so typing replaces it.
  await page.keyboard.press(FIND);
  await expect(field(page)).toHaveValue("needle-7");
  const selected = await field(page).evaluate((input) =>
    input instanceof HTMLInputElement ? [input.selectionStart, input.selectionEnd] : null,
  );
  expect(selected).toEqual([0, "needle-7".length]);

  // Asked for again from the field itself, with the caret at the end, the query is selected again.
  await page.keyboard.press("End");
  await page.keyboard.press(FIND);
  await expect
    .poll(() =>
      field(page).evaluate((input) =>
        input instanceof HTMLInputElement ? [input.selectionStart, input.selectionEnd] : null,
      ),
    )
    .toEqual([0, "needle-7".length]);
});

test("the palette's Find in terminal opens the bar over the terminal in view", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openNewTerminal(page);
  await page.keyboard.press(mac ? "Meta+Shift+P" : "Control+Shift+P");
  await page.keyboard.type("Find in terminal");
  await page.keyboard.press("Enter");
  await expect(field(page)).toBeFocused();
});

for (const [shell, width, height] of [
  ["desktop", 1440, 900],
  ["phone", 390, 844],
] as const) {
  for (const [glyph, query] of [
    ["CJK", "\u754c"],
    ["emoji", "\u{1f680}"],
  ] as const) {
    test(`${shell}: find marks cover both cells of a ${glyph} glyph`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.goto("/");
      if (shell === "phone") {
        await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
        await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
      }
      const terminal = shell === "phone" ? page.locator("[data-terminal]") : await openNewTerminal(page);
      await expect(terminal).toContainText("$");
      // Octal escapes leave only the printed match; blank rows keep it below the phone's find bar.
      await page.keyboard.type("printf '\\n\\n\\347\\225\\214\\360\\237\\232\\200\\n'");
      await page.keyboard.press("Enter");
      await expect(terminal).toContainText("\u754c\u{1f680}");
      await page.keyboard.press(FIND);
      await expect(field(page)).toBeFocused();
      const cell = await terminal.evaluate((element) =>
        parseFloat(getComputedStyle(element).getPropertyValue("--term-cell-width")),
      );
      const current = page.locator('[data-find-match="current"]');

      await field(page).fill(query);
      await expect(findBar(page).getByRole("status")).toHaveText("1 of 1");
      await expect(current).toBeVisible();
      await expect
        .poll(() => current.evaluate((element) => element.getBoundingClientRect().width))
        .toBeCloseTo(cell * 2, 1);
      const barBottom = await findBar(page).evaluate((element) => element.getBoundingClientRect().bottom);
      expect(await current.evaluate((element) => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(
        barBottom,
      );
      await page.screenshot({ path: testInfo.outputPath(`wide-${query.codePointAt(0)}.png`) });
    });
  }
}
