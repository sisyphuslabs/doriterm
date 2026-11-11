import { devices, type Locator } from "@playwright/test";
import { endAgent, startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

/**
 * The lines a count's digits are drawn on: its text has one box per line it runs through, so this counts the wrap itself
 * rather than inferring it from the element's height, which a taller line height would grow too (#984).
 */
const lines = (count: Locator) =>
  count.evaluate((element) => {
    const text = document.createRange();
    text.selectNodeContents(element);
    return new Set([...text.getClientRects()].map((box) => Math.round(box.top))).size;
  });

const started: string[] = [];
test.afterEach(() => {
  for (const address of started.splice(0)) endAgent("host", address);
});

// A machine's count and a space's count, both in tabs (#2122), take the width their digits need: a two-digit count broke
// between its digits on a touch screen, where the text is larger than their one-digit box (#878).
test("ten terminals in one space keep the machine's and the space's counts on one line on a phone (#878)", async ({
  page,
}) => {
  for (let index = 0; index < 10; index += 1) started.push(startShell("host", `count-${index}`));
  // The machines and their spaces are the phone's Spaces tab (mobile nav phase 3).
  await page.goto("/?v=spaces");
  const machine = page
    .locator("[data-machine-header]")
    .getByLabel(/^\d{2,} tabs$/)
    .first();
  const space = page
    .locator("[data-row-meta]")
    .getByLabel(/^\d{2,} tabs$/)
    .first();
  await machine.scrollIntoViewIfNeeded({ timeout: 30_000 });
  await expect(machine).toBeVisible();
  await expect(space).toBeVisible({ timeout: 30_000 });
  expect(await lines(machine), "the machine header's count").toBe(1);
  expect(await lines(space), "the space row's count").toBe(1);
});
