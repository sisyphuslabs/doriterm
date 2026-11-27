import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", ...PHONE });

/** Every height the terminal's box is laid out at from now on, read back with `terminalHeights`. */
const recordHeights = (terminal: Locator): Promise<void> =>
  terminal.evaluate((element) => {
    const heights = [element.getBoundingClientRect().height];
    Reflect.set(window, "__terminalHeights", heights);
    new ResizeObserver(() => heights.push(element.getBoundingClientRect().height)).observe(element);
  });

const terminalHeights = (page: Page): Promise<number[]> =>
  page.evaluate(() => Reflect.get(window, "__terminalHeights") as number[]);

for (const size of [
  { width: 390, height: 844 },
  { width: 320, height: 700 },
]) {
  /**
   * A phone terminal keeps every row while its host's link is down and once it is back (#2853): what the page says
   * about the link is said in the header's second line, at its height, never in a line of its own and never over the
   * terminal (#2464). Past the host's grace, with the redial refused, that line names why with Try again.
   */
  test(`at ${size.width}x${size.height} a link down past the grace, then back, never takes a row from the terminal`, async ({
    page,
  }) => {
    test.slow();
    const link = await routeHcSocket(page);
    const terminal = await openPhoneTerminal(page, size.width);
    await page.setViewportSize(size);
    await expect(page.locator("header[data-phone-top]")).toHaveCount(1);
    await recordHeights(terminal);

    await link.drop(true);
    const header = page.locator("header[data-phone-top]");
    const line = header.locator("[data-host-down]");
    await expect(line).toBeVisible({ timeout: 30_000 });
    const label = line.locator("[data-terminal-line-label]");
    await expect(label).toHaveText("Can't connect");
    await expect(line).toHaveAttribute("role", "status");
    // The words fit the line whole: none of them is cut behind an ellipsis.
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    // Try again's 44 pt target lies inside the header: at its top and bottom edges the tap reaches the button, not the
    // terminal pane under the header.
    const target = await line.locator("[data-terminal-line-action]").evaluate((button) => {
      const after = getComputedStyle(button, "::after");
      const box = button.getBoundingClientRect();
      const top = box.top - Number.parseFloat(after.top) * -1;
      const bottom = box.bottom + Number.parseFloat(after.bottom) * -1;
      const x = box.left + box.width / 2;
      const headerBox = button.closest("header")?.getBoundingClientRect();
      const hits = [top + 1, bottom - 1].map((y) => document.elementFromPoint(x, y) === button);
      return {
        height: bottom - top,
        hits,
        inside: headerBox !== undefined && top >= headerBox.top && bottom <= headerBox.bottom,
      };
    });
    expect(target).toEqual({ height: expect.any(Number), hits: [true, true], inside: true });
    expect(target.height).toBeGreaterThanOrEqual(44);
    await expect(line.getByRole("button", { name: "Try again" })).toBeVisible();
    // The line is in the header, above the terminal: nothing is drawn over the terminal's rows.
    const lineBox = await line.boundingBox();
    const termBox = await terminal.boundingBox();
    expect((lineBox?.y ?? 0) + (lineBox?.height ?? 0)).toBeLessThanOrEqual((termBox?.y ?? 0) + 0.5);
    expect(await header.evaluate((el) => el.getBoundingClientRect().height)).toBe(48);

    link.restore();
    // Back: nothing says the link is down any more (a full reconnect may leave its note that output may be missing).
    await expect(header.locator("[data-terminal-line]:not([data-terminal-line=history-gap])")).toHaveCount(0, {
      timeout: 30_000,
    });
    await terminal.getByRole("textbox").focus();
    await page.keyboard.type("echo rows-kept-$((1+1))");
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText("rows-kept-2", { timeout: 20_000 });

    const heights = await terminalHeights(page);
    expect(new Set(heights).size, `terminal heights through the reconnect: ${heights.join(", ")}`).toBe(1);
  });
}

/**
 * A sub-second blip says nothing (#2853): the page redials at 250, 500 and 1000 ms and says a lost link only once it has
 * lasted 1.5 s, so a link back within 0.8 s is found before any notice is due, during the drop or after it. On this
 * harness's loopback link a drop is a full reattach, whose note that output may be missing is a fact, not a notice about
 * the link; the relay resumes the session instead and never shows it.
 */
test("a 0.8 s blip on a phone terminal shows no notice at any frame, during or after", async ({ page }) => {
  test.slow();
  const link = await routeHcSocket(page);
  const terminal = await openPhoneTerminal(page);
  await page.evaluate(() => {
    const seen: string[] = [];
    Reflect.set(window, "__linkLines", seen);
    const read = (): void => {
      for (const el of document.querySelectorAll("[data-terminal-line], [data-host-down], [data-header-offline]")) {
        const kind = el.getAttribute("data-terminal-line") ?? "line";
        if (kind !== "history-gap") seen.push(kind);
      }
      for (const el of document.querySelectorAll('[role="status"]'))
        if (/Reconnecting|Offline|Can't reach/.test(el.textContent ?? "")) seen.push(el.textContent ?? "");
    };
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await link.drop(true);
  // The blip's length is the behavior under test.
  await page.waitForTimeout(800);
  link.restore();
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("echo blip-quiet-$((1+1))");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("blip-quiet-2", { timeout: 20_000 });
  // Past the gate and the notice's shortest stay: had it been due, it would have shown by now.
  await page.waitForTimeout(2_500);
  expect(await page.evaluate(() => Reflect.get(window, "__linkLines") as string[])).toEqual([]);
});

/** The header line's words open a sheet with the whole explanation and the line's one action (#2904). */
test("the reason in the phone header opens a sheet with the whole explanation and Try again", async ({ page }) => {
  test.slow();
  const link = await routeHcSocket(page);
  await openPhoneTerminal(page);
  await link.drop(true);
  const line = page.locator("header[data-phone-top] [data-host-down]");
  await expect(line).toBeVisible({ timeout: 30_000 });
  await line.getByRole("button", { name: /details$/ }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.locator("[data-terminal-line-detail]")).not.toBeEmpty();
  await expect(sheet.getByRole("button", { name: "Try again" })).toBeVisible();
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toHaveCount(0);
  link.restore();
  await expect(line).toHaveCount(0, { timeout: 30_000 });
});
