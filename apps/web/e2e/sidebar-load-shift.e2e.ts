import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { rows } from "./sidebar-measure.ts";
import { observeSidebarShifts, sidebarShift } from "./sidebar-shift.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

let address = "";
test.beforeAll(() => {
  address = startAgent("host", "rc-shift", "working", "rc206shift");
});
test.afterAll(() => endAgent("host", address));

test("loading the workspace moves nothing in the sidebar: the lists appear once, in place", async ({ page }) => {
  await page.addInitScript(observeSidebarShifts);
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace" });
  await expect(
    rows(sidebar.getByRole("region", { name: "Working", exact: true })).filter({ hasText: "rc-shift" }),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expect(sidebar.locator("[data-machine-header]").first()).toBeVisible({ timeout: 20_000 });
  expect(await sidebarShift(page)).toBe(0);
});

test("a row that really moves in the sidebar is counted, so the zero above is not a blind spot", async ({ page }) => {
  await page.addInitScript(observeSidebarShifts);
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace" });
  const row = rows(sidebar.getByRole("region", { name: "Working", exact: true })).filter({ hasText: "rc-shift" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  expect(await sidebarShift(page)).toBe(0);
  await row.evaluate((node) =>
    node.parentElement?.prepend(Object.assign(document.createElement("div"), { style: "height:48px" })),
  );
  expect(await sidebarShift(page)).toBeGreaterThan(0);
});
