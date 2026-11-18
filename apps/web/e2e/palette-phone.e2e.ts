import { devices, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ ...phone, serviceWorkers: "block" });

const openPalette = async (page: Page) => {
  await page.getByRole("button", { name: "Command palette" }).click();
  await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
};
const run = async (page: Page, name: string | RegExp) => {
  await openPalette(page);
  await page.getByRole("option", { name }).first().click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
};
const fontSize = (page: Page) =>
  page.locator("[data-terminal]").evaluate((el) => getComputedStyle(el).getPropertyValue("--term-font-size").trim());
const backToAgents = async (page: Page) => {
  await page.getByRole("button", { name: "Back to agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
};
const openAgent = async (page: Page) => {
  await openPalette(page);
  await page.getByRole("group", { name: "Agents" }).getByRole("option").first().click();
  await expect(page.locator("[data-terminal]")).toContainText("$", { timeout: 15_000 });
};

test("on a phone every palette row does what it says", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });

  // The header button and the palette row are one action, so they carry one label.
  await openPalette(page);
  const actions = page.getByRole("group", { name: "Actions" }).getByRole("option");
  // innerText leaves out the key hint, which touch layouts hide.
  const rowLabel = await actions.first().evaluate((row) => (row instanceof HTMLElement ? row.innerText.trim() : ""));
  await page.keyboard.press("Escape");
  await expect(page.getByRole("banner").getByRole("button", { name: rowLabel, exact: true })).toBeVisible();
  await openPalette(page);
  // Each row's text also holds its key hint, which touch layouts hide.
  await expect(actions).toHaveText([/^New tab/, /^Larger terminal text/, /^Smaller terminal text/]);
  await page.keyboard.press("Escape");

  await run(page, "New tab");
  await expect(page.locator("[data-terminal]")).toContainText("$", { timeout: 15_000 });
  await backToAgents(page);

  await run(page, "Larger terminal text");
  await openAgent(page);
  expect(await fontSize(page)).toBe("14pt");
  await backToAgents(page);

  await run(page, "Smaller terminal text");
  await openAgent(page);
  expect(await fontSize(page)).toBe("13pt");
  await backToAgents(page);

  await openPalette(page);
  // Every machine is a host row now (#2531); the e2e host's own row opens Settings like any other.
  await page.getByRole("group", { name: "Hosts" }).getByRole("option").first().click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole("button", { name: "Close settings" }).first().click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });

  await run(page, "Open settings");
  await expect(page).toHaveURL(/\/settings$/);
});
