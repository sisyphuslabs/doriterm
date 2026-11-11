import type { Page } from "@playwright/test";
import { BUILTIN_PALETTES, resolveTheme } from "@doriface/ui";
import { expect, followSystemAppearance, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

/**
 * The colour the browser paints its title or status bar with: the first `theme-color` meta whose media matches, and the
 * theme's own `--chrome` token, both as computed rgb() so they compare.
 */
const colours = (page: Page) =>
  page.evaluate(() => {
    const meta = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')).find(
      (tag) => tag.media === "" || matchMedia(tag.media).matches,
    );
    const probe = document.createElement("span");
    document.body.append(probe);
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--chrome").trim();
    const chrome = getComputedStyle(probe).color;
    probe.style.color = meta?.content ?? "";
    const painted = meta === undefined ? null : getComputedStyle(probe).color;
    probe.remove();
    return { meta: painted, chrome };
  });

async function expectFollowsTheme(page: Page): Promise<string> {
  await expect.poll(async () => (await colours(page)).meta).toBe((await colours(page)).chrome);
  return (await colours(page)).chrome;
}

test("the browser chrome colour follows the scheme both ways and a live switch in Settings", async ({ page }) => {
  await followSystemAppearance(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/settings");
  const day = await expectFollowsTheme(page);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(async () => (await colours(page)).chrome).not.toBe(day);
  const night = await expectFollowsTheme(page);

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(async () => (await colours(page)).meta).toBe(day);
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Appearance" }).click();
  await page.getByLabel("Appearance", { exact: true }).getByRole("button", { name: "Dark" }).click();
  await expect.poll(async () => (await colours(page)).meta).toBe(night);
  await page.getByLabel("Appearance", { exact: true }).getByRole("button", { name: "Light" }).click();
  await expect.poll(async () => (await colours(page)).meta).toBe(day);
});

test("the manifest's title-bar and splash colours come from the dark default (#1403)", async ({ request }) => {
  const manifest: unknown = await (await request.get("/manifest.webmanifest")).json();
  const field = (name: string): unknown =>
    typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, name) : null;
  // Night's chrome and background: a fresh install opens dark, so its splash and title bar are Night before React.
  const night = resolveTheme(BUILTIN_PALETTES.night).roles;
  expect({ theme: field("theme_color"), background: field("background_color") }).toEqual({
    theme: night.chrome,
    background: night.background,
  });
});

test("a first launch paints the dark Night chrome before any script runs (#1403)", async ({ browser, baseURL }) => {
  // A light device: the default must still be dark, and the static meta is what a fresh install shows first.
  const context = await browser.newContext({
    javaScriptEnabled: false,
    colorScheme: "light",
    ...(baseURL === undefined ? {} : { baseURL }),
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const metas = await page
      .locator('meta[name="theme-color"]')
      .evaluateAll((tags) =>
        tags.map((tag) => ({ content: tag.getAttribute("content"), media: tag.getAttribute("media") })),
      );
    const night = resolveTheme(BUILTIN_PALETTES.night).roles;
    expect(metas).toEqual([{ content: night.chrome, media: null }]);
  } finally {
    await context.close();
  }
});
