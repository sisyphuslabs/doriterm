// Phone terminal header's compact needs-you pill (#2863): shows other blocked agents without leaving the terminal,
// keeps a 44x44 touch target and header fit at 390 px, and jumps to the blocked agent on tap.
import type { Page } from "@playwright/test";
import { agentRow } from "./agents.ts";
import { expect, laidOutBox, test } from "./fixtures.ts";
import { PHONE } from "./phone-key-bar.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ ...PHONE, serviceWorkers: "block" });

const header = (page: Page) => page.getByRole("banner");

test("at 390 px the phone header shows a tappable compact needs-you pill that opens the blocked agent", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  const needsYouSection = page.getByRole("region", { name: "Needs you", exact: true });
  await expect(needsYouSection).toBeVisible({ timeout: 20_000 });
  const totalBlocked = Number(((await needsYouSection.locator("header [data-numeric]").textContent()) ?? "").trim());
  expect(totalBlocked).toBeGreaterThanOrEqual(1);

  await agentRow(page, "shell", false).click();
  await expect(page.locator("[data-terminal]")).toContainText("$", { timeout: 15_000 });

  const bar = header(page);
  const pill = bar.getByRole("button", { name: `${totalBlocked} needs you, open the next`, exact: true });
  await expect(pill).toBeVisible();

  const pillBox = await laidOutBox(pill);
  expect(pillBox.height).toBeGreaterThanOrEqual(24);
  const hitBox = await pill.evaluate((el) => {
    const after = getComputedStyle(el, "::after");
    return { width: Number.parseFloat(after.width), height: Number.parseFloat(after.height) };
  });
  expect(hitBox.width).toBeGreaterThanOrEqual(44);
  expect(hitBox.height).toBeGreaterThanOrEqual(44);
  expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  await pill.tap();
  await expect(bar.getByRole("heading", { level: 1, name: "deploy", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-terminal]")).toContainText("Waiting for approval", { timeout: 15_000 });

  const remaining = totalBlocked - 1;
  if (remaining === 0) {
    await expect(bar.getByRole("button", { name: /needs you, open the next$/ })).toHaveCount(0);
  } else {
    await expect(bar.getByRole("button", { name: `${remaining} needs you, open the next`, exact: true })).toBeVisible();
  }
});
