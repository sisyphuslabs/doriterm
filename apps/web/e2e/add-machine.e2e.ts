import { expect, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

test("Connect a device in the sidebar footer shows the pairing steps in the app", async ({ page }) => {
  await page.goto("/");
  const footer = page.getByRole("complementary", { name: "Workspace" }).locator('[data-slot="sidebar-footer"]');
  await footer.getByRole("button", { name: "Connect a device" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect a device" });
  // A computer joins from the Computer tab; the sheet opens on a phone or browser.
  await dialog.getByRole("button", { name: "Computer", exact: true }).click();
  await expect(dialog).toContainText("doriface-host pair");
  await expect(dialog).toContainText("doriface-host connect");
  await expect(dialog).toContainText("hc machine add --via 'doriface-host connect");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
