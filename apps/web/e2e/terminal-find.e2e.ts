import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { graphics, png, RED } from "./terminal-images.ts";

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

/** Where the current match's mark is drawn, and where the cells it names actually are, in the terminal's rows. */
function markAndText(terminal: Locator, text: string) {
  return terminal.evaluate((root, needle) => {
    const mark = root.parentElement?.querySelector<HTMLElement>('[data-find-match="current"]');
    const row = [...root.querySelectorAll<HTMLElement>(".term-row")].find((each) => each.textContent?.includes(needle));
    const cell = parseFloat(getComputedStyle(root).getPropertyValue("--term-cell-width"));
    if (mark === undefined || mark === null || row === undefined || !(cell > 0)) return null;
    const at = row.getBoundingClientRect();
    const drawn = mark.getBoundingClientRect();
    const column = (row.textContent ?? "").indexOf(needle);
    return {
      mark: { left: Math.round(drawn.left), top: Math.round(drawn.top) },
      text: { left: Math.round(at.left + column * cell), top: Math.round(at.top) },
    };
  }, text);
}

test("a resize that reflows the scrollback with no new output moves the marks with the text (#1207)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  // A long line with the needle near its end; `sleep` then holds the shell, so nothing is printed back on resize.
  await page.keyboard.type("printf '%080d%s-%s\\n' 0 needle r; sleep 600");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("needle-r", { timeout: 30_000 });
  await page.keyboard.press(FIND);
  await page.keyboard.type("needle-r");
  await expect(findBar(page).getByRole("status")).toHaveText("1 of 1");
  await expect
    .poll(async () => (await markAndText(terminal, "needle-r"))?.mark)
    .toEqual((await markAndText(terminal, "needle-r"))?.text);

  // Narrower than the line: the core reflows it, and the needle moves to the next row, nearer the left edge.
  const before = await markAndText(terminal, "needle-r");
  await page.setViewportSize({ width: 700, height: 900 });
  await expect.poll(async () => (await markAndText(terminal, "needle-r"))?.text).not.toEqual(before?.text);
  await expect
    .poll(async () => {
      const now = await markAndText(terminal, "needle-r");
      return now === null ? null : now.mark.left === now.text.left && now.mark.top === now.text.top;
    })
    .toBe(true);
});

test("text written after a Kitty PNG decodes is found once it reaches the terminal (#1207)", async ({ page }) => {
  test.setTimeout(120_000);
  // Every PNG decode waits until the spec lets it go, so the text queued behind the image is held for certain.
  await page.addInitScript(() => {
    const decode = window.createImageBitmap.bind(window);
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    Reflect.set(window, "__releaseDecode", release);
    Reflect.set(window, "__decodeStarted", false);
    Reflect.set(window, "createImageBitmap", async (...args: Parameters<typeof createImageBitmap>) => {
      Reflect.set(window, "__decodeStarted", true);
      await gate;
      return decode(...args);
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const dir = mkdtempSync(join(tmpdir(), "dh-find-"));
  const out = join(dir, "out");
  const go = join(dir, "go");
  writeFileSync(out, `${graphics("a=T,f=100", png(RED).toString("base64"))}needle-k\n`, "latin1");
  // The shell waits for the spec before printing, so the find bar is open with its query when the output comes.
  await page.keyboard.type(`until [ -e ${go} ]; do sleep 0.1; done; cat ${out}; sleep 600`);
  await page.keyboard.press("Enter");
  await page.keyboard.press(FIND);
  await page.keyboard.type("needle-k");
  const status = findBar(page).getByRole("status");
  await expect(status).toHaveText("No matches");

  writeFileSync(go, "");
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__decodeStarted")), { timeout: 30_000 }).toBe(true);
  // Two painted frames with the text still held behind the image: the find bar has redrawn since the output came.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))),
  );
  await expect(terminal).not.toContainText("needle-k");
  await page.evaluate(() => (Reflect.get(window, "__releaseDecode") as () => void)());
  await expect(terminal).toContainText("needle-k");
  await expect(status).toHaveText("1 of 1");
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
