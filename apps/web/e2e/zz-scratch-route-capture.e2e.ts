import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { type FakeRelayHost, startFakeRelayHost } from "./relay-route.ts";
test.use({ serviceWorkers: "block" });
const KEY = "doriface.connection";
async function pair(page: Page, host: FakeRelayHost): Promise<string> {
  await page.goto(await host.pairingLink());
  await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
  await expect(page.getByRole("status").getByText("Paired")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "Open terminals" }).or(page.getByRole("button", { name: "Open terminals" })).click({ timeout: 30_000 });
  const paired = await page.evaluate((key) => localStorage.getItem(key), KEY);
  if (paired === null) throw new Error("no settings");
  return paired;
}
async function machines(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.getByRole("tab", { name: "Machines" }).or(page.getByRole("button", { name: "Machines" })).first().click();
}
async function shoot(page: Page, phone: boolean, tag: string): Promise<void> {
  const host = await startFakeRelayHost({ direct: true, terminal: true });
  try {
    await page.route("**/src/dev-tools.ts", (route) => route.fulfill({ contentType: "text/javascript", body: "export {};" }));
    await host.route(page);
    const paired = await pair(page, host);
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [KEY, paired] as const);
    if (phone) await machines(page);
    await page.getByRole("button", { name: phone ? "Add a machine" : "Add machine" }).click({ timeout: 60_000 });
    const dialog = page.getByRole("dialog", { name: "Add a machine" });
    const text = (await dialog.getByLabel("Join command").innerText()).trim();
    const link = /--join '(doriface:\/\/pair#[^']+)'/.exec(text)?.[1] ?? "";
    expect(await host.join(link)).toBe("joiner");
    await expect(dialog.getByText("joiner joined this host's mesh")).toBeVisible({ timeout: 60_000 });
    for (const mode of ["dark", "light"] as const) {
      await page.evaluate((m) => localStorage.setItem("doriface.appearance", JSON.stringify({ mode: m })), mode);
      await machines(page);
      const rows = page.getByRole("list", { name: "Machines" }).getByRole("listitem");
      await expect(rows.filter({ hasText: "studio" })).toContainText("Online · Relay", { timeout: 20_000 });
      await expect(rows.filter({ hasText: "joiner" })).toHaveCount(1, { timeout: 30_000 });
      await expect(rows.filter({ hasText: "studio" })).toContainText("Through the relay", { timeout: 20_000 });
      for (const summary of await page.getByText("How it is connected").all()) await summary.click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: "/var/folders/h6/w548ypzn1k78_xqndn63y7xc0000gn/T/tmp.XXUOrGxuU0/shots/machines-" + tag + "-" + mode + ".png", fullPage: true, animations: "disabled" });
    }
  } finally {
    await host.stop();
  }
}
test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test("capture", async ({ page }) => { test.setTimeout(240_000); await shoot(page, false, "1440"); });
});
test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("capture", async ({ page }) => { test.setTimeout(240_000); await shoot(page, true, "390"); });
});
