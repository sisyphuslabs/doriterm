import type { Page } from "@playwright/test";
import { PAIR_CODE } from "./capture-relay.ts";
import { expect, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

async function pendingPair(page: Page) {
  const { promise: held, resolve: finish } = Promise.withResolvers<void>();
  await page.route("https://relay-doriface.omo.dev/v1/pair/*", async (route) => {
    await held;
    await route.fulfill({ status: 404, body: "" });
  });
  await page.goto("/pair");
  await page.getByLabel("Pairing code").fill(PAIR_CODE);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const button = page.getByRole("button", { name: "Pair", exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-busy", "true");
  return { button, finish };
}

test("a fast pairing request keeps its label and never flashes a spinner (#1443)", async ({ page }) => {
  const { button, finish } = await pendingPair(page);
  await page.clock.runFor(500);
  expect(await button.locator("svg").count()).toBe(0);
  await expect(button.getByText("Pair", { exact: true })).toHaveCSS("opacity", "1");
  finish();
  await expect(button).not.toHaveAttribute("aria-busy", "true");
  await page.clock.runFor(1000);
  expect(await button.locator("svg").count()).toBe(0);
});

test("a pending request shows its spinner after one second and clears it on completion (#1443)", async ({ page }) => {
  const { button, finish } = await pendingPair(page);
  await page.clock.runFor(999);
  expect(await button.locator("svg").count()).toBe(0);
  await page.clock.runFor(1);
  await expect(button.locator("svg")).toBeVisible();
  await expect(button).toHaveAttribute("aria-busy", "true");
  finish();
  await expect(button).not.toHaveAttribute("aria-busy", "true");
  await expect(button.locator("svg")).toHaveCount(0);
});

test("reduced motion keeps pending progress visible without rotation (#1443)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { button, finish } = await pendingPair(page);
  await page.clock.runFor(1100);
  await expect(button).toHaveAttribute("aria-busy", "true");
  const spinner = button.locator("svg");
  await expect(spinner).toBeVisible();
  await expect(spinner).toHaveCSS("transform", "none");
  const opacity = await spinner.evaluate((el) => getComputedStyle(el).opacity);
  await expect.poll(() => spinner.evaluate((el) => getComputedStyle(el).opacity)).not.toBe(opacity);
  finish();
  await expect(button).not.toHaveAttribute("aria-busy", "true");
});
