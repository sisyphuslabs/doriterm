// The desktop Settings nav holds the window's drag row as well as the section list: in a window too short for the
// sections, the list scrolls and the title row stays, so the window can still be dragged by it (#1915).
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 320 } });

const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });

test("in a short window the Settings sections scroll under a title row that stays (#1915)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();
  const nav = settings(page).getByRole("navigation", { name: "Settings" });
  const title = nav.getByRole("heading", { name: "Settings" });
  const last = nav.getByRole("button", { name: "Voice input" });
  const titleAt = await title.boundingBox();
  const lastAt = await last.boundingBox();

  await nav.hover();
  await page.mouse.wheel(0, 400);

  // The sections scrolled: the one at the end of the list moved up.
  await expect.poll(async () => (await last.boundingBox())?.y ?? 0).toBeLessThan((lastAt?.y ?? 0) - 20);
  // The title row, which is also the window's drag region, did not move with them.
  expect((await title.boundingBox())?.y).toBe(titleAt?.y);
});
