import type { Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

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

  await pressShortcut(page, "terminal.search");
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
  await pressShortcut(page, "terminal.search");
  await expect(field(page)).toHaveValue("needle-7");
  const selected = await field(page).evaluate((input) =>
    input instanceof HTMLInputElement ? [input.selectionStart, input.selectionEnd] : null,
  );
  expect(selected).toEqual([0, "needle-7".length]);

  // Asked for again from the field itself, with the caret at the end, the query is selected again.
  await page.keyboard.press("End");
  await pressShortcut(page, "terminal.search");
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
  await pressShortcut(page, "app.palette");
  await page.keyboard.type("Find in terminal");
  await page.keyboard.press("Enter");
  await expect(field(page)).toBeFocused();
});
