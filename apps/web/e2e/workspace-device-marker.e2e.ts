import { E2E_TOKEN } from "./config.ts";
import { expect, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

for (const shell of [false, true]) {
  test(`${shell ? "the desktop shell" : "a browser"} labels the connected computer from its own device context`, async ({
    page,
    loopbackUrl,
  }, info) => {
    await page.goto("/");
    const connected = page.locator('[data-machine-header="studio"]');
    await expect(connected).toBeVisible({ timeout: 20_000 });
    if (shell) {
      await page.evaluate((endpoint) => Reflect.set(globalThis, "doriface", { startLocalHost: async () => endpoint }), {
        url: loopbackUrl,
        token: E2E_TOKEN,
      });
      await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
      await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
    }
    await expect(connected).toContainText(shell ? "this machine" : "connected");
    await expect(page.getByText("this machine", { exact: true })).toHaveCount(shell ? 1 : 0);
    await page.screenshot({ path: info.outputPath("workspace-device-context.png"), fullPage: true });
  });
}
