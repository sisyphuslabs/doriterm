// A pinned agent's row and its persistent Unpin control keep their geometry on hover (#1562, Apple HIG).
import type { Page } from "@playwright/test";
import { agentRow, endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });

const agents = (page: Page) =>
  page.getByRole("complementary", { name: "Workspace" }).getByRole("region", { name: "Agents", exact: true });

for (const scheme of ["light", "dark"] as const) {
  test(`in ${scheme}, the pin keeps its size on hover and the row keeps its box`, async ({ page }) => {
    // The app's own appearance setting, which a stored choice overrides (Settings > Appearance).
    await page.addInitScript((mode) => {
      localStorage.setItem(
        "doriface.appearance",
        JSON.stringify({ mode, dark: "night", light: "day", density: "comfortable", custom: [] }),
      );
    }, scheme);
    const name = `pin-hover-${scheme}`;
    const address = startAgent("host", name, "idle", `sp-${name}`);
    try {
      await page.goto("/");
      const row = agentRow(agents(page), name, false);
      await expect(row).toBeVisible({ timeout: 20_000 });
      await row.hover();
      await agents(page)
        .getByRole("button", { name: `Pin ${name} to the top` })
        .click();
      await page.mouse.move(1, 1);
      const unpin = agents(page).getByRole("button", { name: `Unpin ${name}` });
      await expect(unpin).toHaveAttribute("aria-pressed", "true");
      const pinned = unpin.locator("[data-pin-symbol]");
      await expect(pinned).toBeVisible({ timeout: 10_000 });
      const rest = await row.boundingBox();
      const glyphAtRest = await pinned.boundingBox();

      await row.hover();
      await expect(unpin).toBeVisible();
      const hovered = await row.boundingBox();
      const glyphOnHover = await pinned.boundingBox();

      expect(hovered).toEqual(rest);
      expect(glyphOnHover).toEqual(glyphAtRest);
    } finally {
      endAgent("host", address);
    }
  });
}
