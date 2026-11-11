import { expect, terminalCount, test } from "./fixtures.ts";
import { shortcut } from "./platform-keys.ts";

test.use({ serviceWorkers: "block" });

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test.describe(`Settings over workspace overlays at ${viewport.width}px`, () => {
    test.use({ viewport });

    for (const overlay of [
      { action: "app.help", name: "Keyboard shortcuts" },
      { action: "app.palette", name: "Command palette" },
    ]) {
      test(`${overlay.name} closes when Settings opens and stays closed on return (#1229)`, async ({
        page,
      }, testInfo) => {
        await page.goto("/");
        if (viewport.width >= 768) await terminalCount(page);
        else await expect(page.getByRole("button", { name: "Command palette" }).first()).toBeVisible();
        const dialog = page.getByRole("dialog", { name: overlay.name, includeHidden: true });
        const settings = page.getByRole("dialog", { name: "Settings", exact: true });
        const settingsKey = await shortcut(page, "app.settings");
        const roundTrip = async (closeKey: string): Promise<void> => {
          await page.keyboard.press(await shortcut(page, overlay.action));
          await expect(dialog).toBeVisible();
          await page.keyboard.press(settingsKey);
          await expect(page).toHaveURL(/\/settings$/);
          await expect(settings).toBeVisible();
          // A hidden role=dialog still blocks Settings' close handler, so it must leave the DOM.
          await expect(dialog).toHaveCount(0);
          await page.screenshot({
            path: testInfo.outputPath(`settings-${overlay.action}-${closeKey.replaceAll("+", "-")}.png`),
            animations: "disabled",
          });
          await page.keyboard.press(closeKey);
          await expect(page).toHaveURL(/\/$/);
          await expect(settings).toHaveCount(0);
          await expect(dialog).toHaveCount(0);
        };
        await roundTrip("Escape");
        await roundTrip(settingsKey);
        await roundTrip(await shortcut(page, "tab.close"));
      });
    }
  });
}
