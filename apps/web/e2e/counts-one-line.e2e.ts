import { devices, type Locator } from "@playwright/test";
import { endAgent, startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

/** A count's box against its own font size: one line of text stays under two font sizes tall, a wrapped one does not. */
const lines = (count: Locator) =>
  count.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.height < 2 * Number.parseFloat(getComputedStyle(element).fontSize) ? 1 : 2;
  });

const started: string[] = [];
test.afterEach(() => {
  for (const address of started.splice(0)) endAgent("host", address);
});

// A machine's terminal count and a space's tab count take the width their digits need: a two-digit count broke between
// its digits on a touch screen, where the text is larger than their one-digit box (#878).
test("ten terminals in one space keep the machine's and the space's counts on one line on a phone (#878)", async ({
  page,
}) => {
  for (let index = 0; index < 10; index += 1) started.push(startShell("host", `count-${index}`));
  await page.goto("/");
  const terminals = page.getByLabel(/^\d{2,} terminals$/).first();
  const tabs = page.getByLabel(/^\d{2,} tabs$/).first();
  await terminals.scrollIntoViewIfNeeded({ timeout: 30_000 });
  await expect(terminals).toBeVisible();
  await expect(tabs).toBeVisible({ timeout: 30_000 });
  expect(await lines(terminals), "the machine header's count").toBe(1);
  expect(await lines(tabs), "the space row's count").toBe(1);
});
