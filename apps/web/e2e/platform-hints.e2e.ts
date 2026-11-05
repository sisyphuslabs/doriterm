import type { Locator } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";

/** Clicks every match, one at a time, until none is left. */
const removeAll = async (buttons: Locator): Promise<void> => {
  if ((await buttons.count()) === 0) return;
  await buttons.first().click();
  return removeAll(buttons);
};

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

test("off macOS the status bar and sidebar show the palette shortcut as Ctrl Shift P", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64" });
    Object.defineProperty(Navigator.prototype, "userAgent", { get: () => "Mozilla/5.0 (X11; Linux x86_64)" });
  });
  await page.goto("/");
  await openNewTerminal(page);
  const hint = page
    .getByRole("contentinfo")
    .getByRole("button", { name: /Commands/ })
    .locator("kbd > span");
  await expect(hint).toHaveText(["Ctrl", "Shift", "P"]);

  await page.mouse.move(0, 0);
  await page.getByRole("complementary", { name: "Workspace" }).getByRole("button", { name: "Command palette" }).hover();
  const tooltip = page.locator("[data-side]").filter({ hasText: "Command palette" }).locator("kbd > span");
  await expect(tooltip).toHaveText(["Ctrl", "Shift", "P"]);
});

test("off macOS the tab bar and the tab tooltip show Ctrl shortcuts", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64" });
    Object.defineProperty(Navigator.prototype, "userAgent", { get: () => "Mozilla/5.0 (X11; Linux x86_64)" });
  });
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const selected = page.getByRole("tab", { selected: true });
  await expect(selected).toHaveAttribute("title", /\(Ctrl\+\d\)$/);
  await expect(selected).not.toHaveAttribute("title", /⌘/);
  await expect(terminal).toBeVisible();
  // The new tab's label passes through interim names before the shell's own, and each one changes the tab's
  // width, which moves New tab. Hovered before the last of them, the button slides out from under the pointer during
  // the tooltip's open delay and no tooltip opens (#43). Hover once the label is final, so New tab stays put.
  const shell = process.platform === "darwin" ? "bash" : "sh";
  await expect(selected).toHaveAttribute("title", new RegExp(`^${shell} \\(Ctrl\\+\\d\\)$`), { timeout: 15_000 });
  await page.getByRole("button", { name: "New tab" }).hover();
  const tooltip = page.locator("[data-side]").filter({ hasText: "New tab" }).locator("kbd > span");
  await expect(tooltip).toHaveText(["Ctrl", "Shift", "T"]);
});

test("with New tab unbound the tab bar shows no shortcut for it", async ({ page }) => {
  await page.goto("/settings");
  await page
    .getByRole("tab", { name: "Keybindings" })
    .or(page.getByRole("button", { name: "Keybindings" }))
    .first()
    .click();
  const removes = page.getByRole("button", { name: /^Remove .* from New tab$/ });
  await expect(removes.first()).toBeVisible();
  await removeAll(removes);
  await page.getByRole("button", { name: "Close settings" }).first().click();
  const newTab = page.getByRole("button", { name: "New tab" });
  await newTab.hover();
  const tooltip = page.locator("[data-side]").filter({ hasText: "New tab" }).last();
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator("kbd")).toHaveCount(0);
});
