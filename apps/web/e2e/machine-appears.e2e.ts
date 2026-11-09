import { expect, test } from "./fixtures.ts";
import { newOn, switchTo } from "./machine-switch.ts";

test.use({ serviceWorkers: "block" });

test("a machine added while this page is open appears without an interaction, and how long it takes", async ({
  page,
}) => {
  switchTo("off");
  await page.goto("/");
  await expect(newOn(page)).toHaveCount(0, { timeout: 20_000 });

  const opened = Date.now();
  switchTo("login");
  await expect(newOn(page)).toBeVisible({ timeout: 30_000 });
  const took = Date.now() - opened;

  // Q's ask is that a newly added machine shows at once. This records what it actually costs today, so the fix has a
  // number to beat rather than an opinion.
  console.log(`MACHINE_APPEARED_MS ${took}`);
  expect(took).toBeLessThan(1_000);
});
