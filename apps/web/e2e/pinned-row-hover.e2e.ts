// A pinned agent's row keeps its pin the same size on hover, where Unpin takes its place, and the row itself does not
// move or grow: hover reveals an action, it never resizes anything (#1562, Apple HIG).
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
      const pinned = agents(page).getByRole("img", { name: "Pinned" });
      await expect(pinned).toBeVisible({ timeout: 10_000 });
      await expect(pinned).toHaveClass(/lucide-pin(?!-)/);
      const rest = await row.boundingBox();
      const glyphAtRest = await pinned.boundingBox();

      await row.hover();
      const unpin = agents(page).getByRole("button", { name: `Unpin ${name}` });
      await expect(unpin).toBeVisible();
      const hovered = await row.boundingBox();
      const glyphOnHover = await unpin.locator("svg").boundingBox();

      expect(hovered).toEqual(rest);
      // The same pin shape (lucide's pin) at rest and on hover; PinOff draws a smaller body in the same box.
      await expect(unpin.locator("svg.lucide-pin")).toHaveCount(1);
      expect(glyphOnHover?.width).toBe(glyphAtRest?.width);
      expect(glyphOnHover?.height).toBe(glyphAtRest?.height);
    } finally {
      endAgent("host", address);
    }
  });
}
