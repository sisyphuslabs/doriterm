import { devices, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });
const field = (page: Page) => settings(page).getByRole("searchbox", { name: "Search settings" });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("one field searches every section: it narrows the list, Enter opens the first match, Escape clears it (#1460)", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).click();
    const nav = settings(page).getByRole("navigation", { name: "Settings" });
    await field(page).fill("theme");
    await expect(nav.getByRole("button", { name: "Appearance" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Keybindings" })).toHaveCount(0);
    await field(page).press("Enter");
    await expect(nav.getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "page");
    await expect(settings(page).getByRole("heading", { name: "Appearance", level: 2 })).toBeVisible();

    await field(page).fill("zzz");
    await expect(nav).toContainText('No setting matches "zzz"');
    await field(page).press("Escape");
    await expect(field(page)).toHaveValue("");
    await expect(settings(page)).toBeVisible();
    await expect(nav.getByRole("button", { name: "Keybindings" })).toBeVisible();
  });
});

test.describe("desktop: matching settings (#1528)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a query lists the matching settings; Enter lands on the first, focused, in its section", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).click();
    await field(page).fill("cursor");
    const hits = settings(page).getByRole("region", { name: "Matching settings" });
    const style = hits.getByRole("button", { name: /^cursor-style Terminal/ });
    await expect(style).toBeVisible();
    await field(page).press("ArrowDown");
    await expect(hits.getByRole("button").first()).toBeFocused();
    await style.focus();
    await page.keyboard.press("Enter");
    await expect(hits).toHaveCount(0);
    const nav = settings(page).getByRole("navigation", { name: "Settings" });
    await expect(nav.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-current", "page");
    const landed = settings(page).locator("[data-setting-landed]");
    await expect(landed).toHaveCount(1);
    await expect(landed.locator("#terminal-cursor-style")).toHaveCount(1);
    await expect.poll(() => landed.evaluate((row) => row.contains(document.activeElement))).toBe(true);
  });

  test("keybinds finds the keybinding import, and picking it focuses that button (#1472)", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).click();
    await field(page).fill("keybinds");
    const hits = settings(page).getByRole("region", { name: "Matching settings" });
    await hits.getByRole("button", { name: /^Import keybinds…/ }).click();
    await expect(settings(page).getByRole("button", { name: "Import keybinds…" })).toBeFocused();
  });
});

test.describe("desktop: a match that lands nowhere (#1545 review)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the next search keeps the field: a pending landing never takes the focus from it", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).click();
    await field(page).fill("connect through");
    const hits = settings(page).getByRole("region", { name: "Matching settings" });
    await hits.getByRole("button", { name: /^Connect through/ }).click();
    await field(page).click();
    await field(page).pressSequentially("connect");
    await expect(field(page)).toHaveValue("connect");
    await expect(field(page)).toBeFocused();
    await expect(hits.locator("[data-setting-landed]")).toHaveCount(0);
  });
});

test.describe("phone", () => {
  const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
  test.use(phone);

  test("the phone's section tabs narrow to the sections that hold the words (#1460)", async ({ page }) => {
    await page.goto("/settings");
    await field(page).fill("relay");
    const tabs = settings(page).getByRole("tablist");
    await expect(tabs.getByRole("tab", { name: "This device" })).toBeVisible();
    await expect(tabs.getByRole("tab")).toHaveCount(1);
  });

  test("the phone's search field shows its whole hint beside the title (#2575)", async ({ page }) => {
    await page.goto("/settings");
    await expect(field(page)).toBeVisible();
    // The hint's width in the field's own font, against the room the field leaves for text.
    const fit = await field(page).evaluate((input: HTMLInputElement) => {
      const style = getComputedStyle(input);
      const context = document.createElement("canvas").getContext("2d");
      if (context === null) return { hint: -1, room: 0 };
      context.font = style.font;
      const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      return { hint: Math.ceil(context.measureText(input.placeholder).width), room: input.clientWidth - padding };
    });
    expect(fit.hint).toBeGreaterThan(0);
    expect(fit.hint, `the hint takes ${fit.hint}px of the ${fit.room}px it has`).toBeLessThanOrEqual(fit.room);
  });

  test("a tapped match opens its section with that row in view (#1528)", async ({ page }) => {
    await page.goto("/settings");
    await field(page).fill("awake");
    const hits = settings(page).getByRole("region", { name: "Matching settings" });
    await hits.getByRole("button", { name: /^Keep the screen awake/ }).tap();
    const landed = settings(page).locator("[data-setting-landed]");
    await expect(landed).toContainText("Keep the screen awake");
    await expect(landed).toBeInViewport();
  });
});
