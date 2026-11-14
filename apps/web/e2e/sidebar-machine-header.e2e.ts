import type { Page } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, laidOutBox, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { MACHINE_NAME } from "./machine.ts";
import { pressShortcut } from "./platform-keys.ts";
import { rows } from "./sidebar-measure.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

const spaces = (page: Page) =>
  page.getByRole("complementary", { name: "Workspace" }).getByRole("region", { name: "Spaces", exact: true });
/** A machine's group, named after it; this core's (host.ts names it `studio`) when none is named. */
const group = (page: Page, name = "studio") => spaces(page).getByRole("region", { name, exact: true });

let address = "";
test.beforeAll(() => {
  address = startAgent("host", "mh-fold", "idle", "mhfold");
});
test.afterAll(() => endAgent("host", address));

test("each machine header carries New space, a status dot and a fold chevron that hides its spaces across a reload", async ({
  page,
}) => {
  // The sidebar lists the layout's spaces (#404): one named mhfold, showing the agent.
  seedSpaces([
    { id: "spc-mhfold", name: "mhfold", folder: "", tabs: [{ id: "tb-mhfold", name: "", terminal: address }] },
  ]);
  await page.goto("/");
  const studio = group(page);
  await expect(rows(spaces(page)).filter({ hasText: "mhfold" })).toBeVisible({ timeout: 20_000 });
  await expect(studio.getByRole("button", { name: /^New space on / })).toBeVisible();
  await expect(studio.locator("[data-machine-dot]")).toHaveAttribute("data-machine-dot", "online");
  const fold = studio.getByRole("button", { name: /^Collapse / });
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await fold.click();
  await expect(rows(spaces(page)).filter({ hasText: "mhfold" })).toHaveCount(0);
  await page.reload();
  await expect(group(page).getByRole("button", { name: /^Expand / })).toHaveAttribute("aria-expanded", "false", {
    timeout: 20_000,
  });
  await expect(rows(spaces(page)).filter({ hasText: "mhfold" })).toHaveCount(0);
  await group(page)
    .getByRole("button", { name: /^Expand / })
    .click();
  await expect(rows(spaces(page)).filter({ hasText: "mhfold" })).toBeVisible();
});

test("filtering keeps New space and the dot where they were, the fold chevron's slot reserved (#1158)", async ({
  page,
}) => {
  await page.goto("/");
  const studio = group(page);
  const newSpace = studio.getByRole("button", { name: /^New space on / });
  const dot = studio.locator("[data-machine-dot]");
  await expect(newSpace).toBeVisible({ timeout: 20_000 });
  const buttonBefore = await laidOutBox(newSpace);
  const dotBefore = await laidOutBox(dot);

  await pressShortcut(page, "layout.filter:sidebar");
  const field = page
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("searchbox", { name: "Filter sidebar" });
  await expect(field).toBeFocused();
  await page.keyboard.type("studio");
  // The toggle leaves while the lists are narrowed (#850); the space it filled must stay filled.
  await expect(studio.getByRole("button", { name: /^Collapse / })).toHaveCount(0);

  expect((await laidOutBox(newSpace)).x).toBe(buttonBefore.x);
  expect((await laidOutBox(dot)).x).toBe(dotBefore.x);
});

test("a machine with no spaces offers New space there under its header", async ({ page }) => {
  await page.goto("/");
  const remote = group(page, MACHINE_NAME);
  await expect(remote.getByRole("button", { name: "New space there" })).toBeVisible({ timeout: 20_000 });
});
