import { expect, test } from "./fixtures.ts";

const devices = [
  { name: "phone", id: "3FA94C0E", pairedAt: "2026-11-06T07:00:00.000Z" },
  { name: "laptop", id: "AB12CD34", pairedAt: "2026-11-05T09:30:00.000Z" },
];

test.use({ serviceWorkers: "block" });

/**
 * Settings > This device (Host) with the desktop shell's two calls answered by a fake, which is the only way a browser spec
 * can reach them: the real ones arrive over IPC from the shell that spawned this computer's host.
 */
test("settings lists this computer's paired devices and asks before revoking one", async ({ page }, info) => {
  await page.addInitScript((listed) => {
    Reflect.set(window, "doriface", {
      pairedDevices: async () => ({ state: "listed", devices: listed }),
      revokeDevice: async (id: string) => ({
        state: "revoked",
        device: listed.find((device) => device.id === id),
        devices: listed.filter((device) => device.id !== id),
      }),
    });
  }, devices);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Host", exact: true }) });
  await expect(section.getByText("3FA94C0E", { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(section.getByRole("button", { name: "Revoke" })).toHaveCount(2);
  await info.attach("paired-devices.png", { body: await page.screenshot(), contentType: "image/png" });

  await section.getByRole("button", { name: "Revoke" }).first().click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("Revoke phone?")).toBeVisible();
  await info.attach("revoke-confirm.png", { body: await page.screenshot(), contentType: "image/png" });
  await dialog.getByRole("button", { name: "Revoke" }).click();

  await expect(section.getByText("3FA94C0E", { exact: false })).toHaveCount(0, { timeout: 20_000 });
  await expect(section.getByRole("button", { name: "Revoke" })).toHaveCount(1);
  await expect(page.getByRole("status").filter({ hasText: "phone can no longer reach this computer" })).toBeVisible();
});
