import { expect, test } from "./fixtures.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { inserted, ready } from "./motion-watch.ts";
import { openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

// The redesign's second motion pass (#2875): panels and screens that came and went in one frame now move on the #2796
// tokens, and leave as an inert picture that plays its exit (the mechanism Back uses). The keys panel's ride is in
// phone-keys-ride.e2e.ts.

test.use({ serviceWorkers: "block" });

test.describe("an iPad in portrait (medium)", () => {
  test.use({ viewport: { width: 820, height: 1180 } });

  test("the sidebar drawer slides in with its scrim fading, and slides out as a picture", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    const opening = await inserted(page, "[data-sidebar-drawer]");
    await page.getByRole("button", { name: "Show sidebar" }).click();
    expect((await opening()).motions).toContainEqual({ what: "transform", duration: 320 });
    await expect(page.locator("[data-sidebar-drawer]")).toBeVisible();

    const closing = await inserted(page, "[data-leaving]:has(*)");
    await page.keyboard.press("Escape");
    const picture = await closing();
    expect(picture.motions).toEqual([{ what: "transform", duration: 200 }]);
    expect(picture.opacity).toBe("1");
    await expect(page.locator("[data-sidebar-drawer]")).toHaveCount(0);
    await expect(page.locator("[data-leaving]")).toHaveCount(0);
  });

  test("under reduced motion the drawer cross-fades in and goes at once", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await ready(page);
    const opening = await inserted(page, "[data-sidebar-drawer]");
    await page.getByRole("button", { name: "Show sidebar" }).click();
    expect((await opening()).motions.map((motion) => motion.what)).toEqual(["opacity"]);
    await expect(page.locator("[data-sidebar-drawer]")).toBeVisible();

    await page.evaluate(() => {
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes)
            if (node instanceof HTMLElement && node.hasAttribute("data-leaving")) Reflect.set(window, "__left", true);
      }).observe(document.body, { childList: true });
    });
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-sidebar-drawer]")).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, "__left") === true)).toBe(false);
  });
});

test.describe("a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Settings' dialog scale-fades in and fades out as a picture", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    const opening = await inserted(page, "[data-settings-dialog]");
    await page.getByRole("link", { name: "Settings" }).click();
    const dialog = await opening();
    expect(dialog.motions).toContainEqual({ what: "transform", duration: 220 });
    expect(dialog.motions).toContainEqual({ what: "opacity", duration: 220 });

    const closing = await inserted(page, "[data-leaving]:has(*)");
    await page.keyboard.press("Escape");
    expect((await closing()).motions).toEqual([{ what: "opacity,transform", duration: 200 }]);
    await expect(page.locator("[data-leaving]")).toHaveCount(0);
  });

  test("Settings scrolled partway leaves showing what was on screen, not its top", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    await page.getByRole("link", { name: "Settings" }).click();
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Keybindings" }).click();
    const body = page.locator('[data-settings-dialog] [data-slot="settings-body"]');
    const top = await body.evaluate((viewport) => {
      viewport.scrollTop = 400;
      return viewport.scrollTop;
    });
    expect(top).toBeGreaterThan(0);

    const closing = await inserted(page, "[data-leaving]:has(*)");
    await page.keyboard.press("Escape");
    expect((await closing()).scrolled).toBe(top);
  });
});

test.describe("a touch phone", () => {
  test.use(PHONE);

  endOwnTerminals();

  test("Settings is pushed in from the trailing edge and slides off as Back does", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
    await ready(page);
    const opening = await inserted(page, "[data-settings-sheet]");
    await page.getByRole("link", { name: "Settings" }).click();
    expect((await opening()).motions).toContainEqual({ what: "transform", duration: 320 });

    const closing = await inserted(page, "[data-leaving]");
    await page.keyboard.press("Escape");
    const picture = await closing();
    expect(picture.motions).toEqual([{ what: "transform", duration: 200 }]);
    expect(picture.opacity).toBe("1");
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    await expect(page.locator("[data-leaving]")).toHaveCount(0);
  });

  test("Back's picture of the terminal starts as it was drawn, not from its own arrival", async ({ page }) => {
    await openPhoneTerminal(page);
    const closing = await inserted(page, "[data-leaving]");
    await page.getByRole("button", { name: "Back to agents" }).click();
    const picture = await closing();
    expect(picture.opacity).toBe("1");
    expect(picture.motions).toEqual([{ what: "transform", duration: 200 }]);
  });
});
