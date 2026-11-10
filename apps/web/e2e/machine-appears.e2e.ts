import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { newOn, switchTo } from "./machine-switch.ts";

test.use({ serviceWorkers: "block" });

test("a machine added while this page is open appears without an interaction, and how long it takes", async ({
  page,
}) => {
  switchTo("off");
  await page.goto("/");
  await expect(newOn(page)).toHaveCount(0, { timeout: 20_000 });

  // The page stamps the moment the row's button shows. Timing the expect below instead would measure its retry schedule
  // (re-checks about 0.35 s and 0.85 s in), which reads a row that came at 0.4 s as about 0.85 s. The row can already be
  // in the page but hidden, so every attribute change is checked, and only a shown button counts.
  await page.evaluate((label) => {
    const probe = { appeared: 0 };
    Object.assign(window, { machineProbe: probe });
    const seen = new MutationObserver(() => {
      const button = document.querySelector(`button[aria-label="${label}"]`);
      if (button === null || !button.checkVisibility({ visibilityProperty: true })) return;
      if (button.closest('[aria-hidden="true"],[inert]') !== null) return;
      seen.disconnect();
      probe.appeared = Date.now();
    });
    seen.observe(document.body, { childList: true, subtree: true, attributes: true });
  }, `New space on ${MACHINE_NAME}`);

  const opened = Date.now();
  switchTo("login");
  await expect(newOn(page)).toBeVisible({ timeout: 30_000 });
  const appeared = await page.evaluate(() => (Reflect.get(window, "machineProbe") as { appeared: number }).appeared);
  const took = appeared - opened;

  // Q's ask is that a newly added machine shows at once. This records what it actually costs today, so the fix has a
  // number to beat rather than an opinion.
  console.log(`MACHINE_APPEARED_MS ${took}`);
  expect(appeared).toBeGreaterThan(0);
  expect(took).toBeLessThan(1_000);
});
