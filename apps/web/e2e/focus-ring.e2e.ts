import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

/** Presses Tab until the target holds focus, the way a keyboard user reaches it. */
async function tabTo(page: Page, target: Locator, limit = 160): Promise<void> {
  await expect(target).toBeVisible();
  const reached = async (): Promise<boolean> => {
    if (await target.evaluate((el) => el === document.activeElement)) return true;
    await page.keyboard.press("Tab");
    return false;
  };
  for (let press = 0; press < limit; press += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each Tab moves on from where the previous one left focus
    if (await reached()) return;
  }
  throw new Error(`Tab never reached ${String(target)}`);
}

/** The focused control draws a solid ring of at least 2 px in a colour that is not transparent. */
async function expectRing(target: Locator): Promise<void> {
  const ring = await target.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      focusVisible: el.matches(":focus-visible"),
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      color: style.outlineColor,
    };
  });
  expect(ring.focusVisible).toBe(true);
  expect(ring.style).toBe("solid");
  expect(ring.width).toBeGreaterThanOrEqual(2);
  expect(ring.color).not.toMatch(/rgba\(.*,\s*0\)$|transparent/);
}

async function ringOnTab(page: Page, target: Locator): Promise<void> {
  await tabTo(page, target);
  await expectRing(target);
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`focus rings in ${colorScheme}`, () => {
    test.use({ colorScheme });

    test("the workspace controls Tab reaches draw a focus ring", async ({ page }) => {
      await page.goto("/");
      await openNewTerminal(page);
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      const sidebar = page.getByRole("complementary", { name: "Workspace" });
      await ringOnTab(page, sidebar.getByRole("region", { name: "Idle" }).getByRole("button").first());
      await ringOnTab(page, sidebar.getByRole("link", { name: "Settings" }));
      await ringOnTab(page, page.getByRole("tab").first());
    });

    test("the settings controls Tab reaches draw a focus ring", async ({ page }) => {
      await page.goto("/settings");
      const nav = page.getByRole("navigation", { name: "Settings" });
      await ringOnTab(page, nav.getByRole("button", { name: "Appearance" }));
      await ringOnTab(page, nav.getByRole("button", { name: "Terminal" }));
      await ringOnTab(page, nav.getByRole("button", { name: "Keybindings" }));
      const open = async (name: string): Promise<void> => {
        await nav.getByRole("button", { name }).click();
      };
      await open("Connections");
      await ringOnTab(page, page.getByLabel("Connect through").getByRole("button", { name: "Relay" }));
      await open("Appearance");
      await ringOnTab(page, page.getByLabel("Appearance", { exact: true }).getByRole("button", { name: "System" }));
      await ringOnTab(page, page.getByRole("searchbox", { name: "Search themes" }));
      await ringOnTab(
        page,
        page
          .getByRole("radiogroup", { name: /themes$/ })
          .getByRole("radio")
          .first(),
      );
      await ringOnTab(page, page.getByRole("button", { name: "Choose file…" }));
      await open("Terminal");
      await ringOnTab(page, page.getByRole("button", { name: "Import Ghostty config…" }));
      await ringOnTab(page, page.getByRole("switch", { name: "font-thicken" }));
      await ringOnTab(
        page,
        page.getByLabel("cursor-style", { exact: true }).getByRole("button", { name: "block", exact: true }),
      );
      await open("Keybindings");
      await ringOnTab(page, page.getByRole("button", { name: "Import keybinds…" }));
      await ringOnTab(page, page.getByRole("button", { name: "Export" }));
    });
  });
}
