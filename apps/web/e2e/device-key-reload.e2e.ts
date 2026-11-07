import { expect, test } from "./fixtures.ts";
import { startFakeRelayHost } from "./relay-route.ts";

test.use({ serviceWorkers: "block" });

test("a paired device is still known after the page reloads (#1329)", async ({ page }) => {
  test.setTimeout(180_000);
  const host = await startFakeRelayHost();
  try {
    await host.route(page);
    await page.goto(await host.pairingLink());
    await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
    await expect(page.getByRole("status").getByText("Paired")).toBeVisible({ timeout: 30_000 });
    const saved = await page.evaluate(() => localStorage.getItem("doriface.connection"));
    if (saved === null) throw new Error("the app saved no connection");
    await page.addInitScript((value) => localStorage.setItem("doriface.connection", value), saved);
    await page.reload();
    await expect(page.getByText("The host does not know this device anymore")).toHaveCount(0, { timeout: 60_000 });
  } finally {
    await host.stop();
  }
});
