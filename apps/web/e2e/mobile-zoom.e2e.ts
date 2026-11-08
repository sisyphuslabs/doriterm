import { devices } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

/** The terminal's own text size at the default setting, which its keyboard sink inherits through `font: inherit`. */
const TERMINAL_TEXT_PX = 13;

/**
 * iOS zooms the page when a field it focuses has a font-size under 16 px, and the terminal's keyboard sink is exactly
 * such a field: `@wterm/dom`'s `InputHandler` creates it with `font: "inherit"`, so it takes the terminal's own size,
 * which is 13 px at the default text size (#1379). The sink sits at the cursor and is visible on a phone (`opacity: 1`
 * when the pointer is coarse), so every tap that gives the terminal the keyboard can zoom the page.
 *
 * The sink is built here the way the package builds it, inside the real document, so the assertion is about the app's
 * own stylesheet and fails if the rule that overrides it is removed.
 */
test("the terminal's keyboard sink stays at or above 16px on a phone, so a tap does not zoom", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((textPx: number) => {
    const host = document.createElement("div");
    host.setAttribute("data-terminal", "");
    host.style.fontSize = `${textPx}px`;
    const sink = document.createElement("textarea");
    sink.id = "sink-under-test";
    sink.style.font = "inherit";
    host.appendChild(sink);
    document.body.appendChild(host);
  }, TERMINAL_TEXT_PX);

  const sink = page.locator("#sink-under-test");
  await expect(sink).toHaveCount(1);
  const size = await sink.evaluate((element) => getComputedStyle(element).fontSize);
  expect(parseFloat(size)).toBeGreaterThanOrEqual(16);
});
