import { expect, openNewTerminal, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

test("the skip links clear the window buttons when the titlebar is inset", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  await page.evaluate(() => document.documentElement.style.setProperty("--titlebar-inset-start", "96px"));
  await page.getByRole("button", { name: "Command palette" }).focus();
  // Back past the titlebar's sidebar toggle (#415), then the two skip links.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  const skip = page.getByRole("link", { name: "Skip to terminal" });
  await expect(skip).toBeFocused();
  expect((await skip.boundingBox())?.x ?? 0).toBeGreaterThanOrEqual(96);
});
