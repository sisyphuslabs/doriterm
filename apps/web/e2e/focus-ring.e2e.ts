import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { rows } from "./sidebar-measure.ts";

test.use({ serviceWorkers: "block" });

/** Presses Tab until the target holds focus, the way a keyboard user reaches it. */
async function tabTo(page: Page, target: Locator, limit = 160): Promise<void> {
  await expect(target).toBeVisible();
  const reached = async (): Promise<boolean> => {
    if (await target.evaluate((el) => el === document.activeElement)) return true;
    // A terminal takes the keyboard once its view is ready, which can land after the spec left it, and there every Tab
    // goes to the shell (#335): leave it again before the next Tab.
    const inTerminal = await page.evaluate(() => document.activeElement?.closest("[data-terminal]") != null);
    if (inTerminal) await page.locator("body").click({ position: { x: 1, y: 1 } });
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

/** Settings, with `section` open: each part Tab-walks one section, so no part carries another's walk. */
async function settings(page: Page, section?: string): Promise<void> {
  await page.goto("/settings");
  if (section !== undefined)
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: section }).click();
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
      await ringOnTab(page, rows(sidebar.getByRole("region", { name: "Idle" })).first());
      await ringOnTab(page, sidebar.getByRole("link", { name: "Settings" }));
      await ringOnTab(page, page.getByRole("tab").first());
    });

    test("a scrolling region Tab reaches draws a focus ring (#357)", async ({ page }) => {
      // The viewport is a Tab stop only while it scrolls: a short window makes the settings body overflow.
      await page.setViewportSize({ width: 1280, height: 360 });
      await page.goto("/settings");
      const body = page.locator('[data-slot="settings-body"]');
      await expect.poll(() => body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      await ringOnTab(page, body);
    });

    test("the settings navigation Tab reaches draws a focus ring", async ({ page }) => {
      await settings(page);
      const nav = page.getByRole("navigation", { name: "Settings" });
      await ringOnTab(page, nav.getByRole("button", { name: "Appearance" }));
      await ringOnTab(page, nav.getByRole("button", { name: "Terminal" }));
      await ringOnTab(page, nav.getByRole("button", { name: "Keybindings" }));
    });

    test("the Advanced connection controls under This device draw a focus ring", async ({ page }) => {
      await settings(page, "This device");
      // A release build has no Connect through switch (#389): the gateway of this loopback link is the section's control.
      await ringOnTab(page, page.getByRole("textbox", { name: "Gateway", exact: true }));
    });

    test("the Appearance controls Tab reaches draw a focus ring", async ({ page }) => {
      await settings(page, "Appearance");
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
    });

    test("the Terminal controls Tab reaches draw a focus ring", async ({ page }) => {
      await settings(page, "Terminal");
      await ringOnTab(page, page.getByRole("button", { name: "Import Ghostty config…" }));
      await ringOnTab(page, page.getByRole("switch", { name: "font-thicken" }));
      await ringOnTab(
        page,
        page.getByLabel("cursor-style", { exact: true }).getByRole("button", { name: "block", exact: true }),
      );
    });

    test("the Keybindings controls Tab reaches draw a focus ring", async ({ page }) => {
      await settings(page, "Keybindings");
      await ringOnTab(page, page.getByRole("button", { name: "Import keybinds…" }));
      await ringOnTab(page, page.getByRole("button", { name: "Export" }));
    });

    // Tab reaches only the value field: the - and + buttons stay out of the tab order (arrow keys step the value).
    test("a number stepper's value field Tab reaches draws a focus ring", async ({ page }) => {
      await settings(page, "Terminal");
      await ringOnTab(page, page.getByRole("textbox", { name: "font-size", exact: true }));
    });
  });
}
