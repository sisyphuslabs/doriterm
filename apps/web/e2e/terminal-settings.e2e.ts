import type { Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { PHONE } from "./phone-key-bar.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

test("font-size and cursor-style apply to an open terminal", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const mounted = await terminal.elementHandle();
  if (mounted === null) throw new Error("no terminal element");
  const fontSize = () => mounted.evaluate((el) => getComputedStyle(el).getPropertyValue("--term-font-size").trim());
  expect(await fontSize()).toBe("13pt");

  // Live: the zoom shortcut changes font-size on this same, still mounted terminal element.
  await terminal.getByRole("textbox").focus();
  await page.keyboard.press("ControlOrMeta+Equal");
  await expect.poll(fontSize).toBe("14pt");
  expect(await mounted.evaluate((el) => el.isConnected)).toBe(true);

  await page.getByRole("link", { name: "Settings" }).first().click();
  await page
    .getByRole("tab", { name: "Terminal" })
    .or(page.getByRole("button", { name: "Terminal" }))
    .first()
    .click();
  await page.getByRole("button", { name: "Increase font-size" }).click();
  await page
    .getByRole("radio", { name: "bar" })
    .or(page.getByRole("button", { name: "bar" }))
    .first()
    .click();

  await page.getByRole("button", { name: "Close settings" }).first().click();
  const focused = page.locator('[data-focused="true"] [data-terminal]');
  await expect(focused).toContainText("$", { timeout: 20_000 });
  await expect
    .poll(() => focused.evaluate((el) => getComputedStyle(el).getPropertyValue("--term-font-size").trim()))
    .toBe("14.5pt");
  await expect(focused.locator("[data-cursor-shape]")).toHaveAttribute("data-cursor-shape", "bar", { timeout: 10_000 });
});

/** Settings search finds Predict typing, lands focused on its row, and Never is saved as Doriterm's own preference. */
async function choosePredictTypingNever(page: Page): Promise<void> {
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("searchbox", { name: "Search settings" }).fill("predict");
  const hits = settings.getByRole("region", { name: "Matching settings" });
  await hits.getByRole("button", { name: /^Predict typing/ }).click();
  const landed = settings.locator("[data-setting-landed]");
  await expect(landed.locator("#terminal-predict-typing")).toHaveCount(1);
  await expect.poll(() => landed.evaluate((row) => row.contains(document.activeElement))).toBe(true);
  await expect(landed.getByRole("button", { name: "When slow" })).toHaveAttribute("aria-pressed", "true");
  await landed.getByRole("button", { name: "Never" }).click();
  await expect(landed.getByRole("button", { name: "Never" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("doriface.prediction"))).toBe('{"mode":"never"}');
}

test.describe("desktop: Predict typing", () => {
  test("settings search lands on Predict typing, and Never is saved", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).first().click();
    await choosePredictTypingNever(page);
  });
});

test.describe("phone: Predict typing", () => {
  test.use(PHONE);

  test("settings search lands on Predict typing, and Never is saved", async ({ page }) => {
    await page.goto("/settings");
    await choosePredictTypingNever(page);
  });
});
