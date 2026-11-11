import { expect, openNewTerminal, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";

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
  await pressShortcut(page, "app.zoom_in");
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
