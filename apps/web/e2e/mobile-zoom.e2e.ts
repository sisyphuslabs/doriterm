import { devices, type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";
import { key, keysBar, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

/**
 * A phone zooms this page two ways (#1380). iOS zooms whenever a field it focuses has a font-size under 16 px, and keeps
 * the zoom; and with no `touch-action` a quick second tap is taken as a double-tap zoom instead of a second tap. Neither
 * engine Playwright drives zooms on its own, so these specs pin what makes a phone zoom: each field's computed size on a
 * coarse pointer, the computed `touch-action` of what a finger taps, and a viewport that still lets a person pinch.
 */

const { defaultBrowserType: _pixelBrowser, ...pixel } = devices["Pixel 7"];
const PHONES = [
  ["iPhone 14", PHONE],
  ["Pixel 7", pixel],
] as const;

const TEXT_FIELDS = [
  'input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"], [type="button"],',
  '[type="submit"], [type="reset"], [type="image"], [type="hidden"])',
  ", textarea, select",
].join(" ");

const zoomingFields = (page: Page): Promise<string[]> =>
  page.locator(TEXT_FIELDS).evaluateAll((fields) =>
    fields
      .map((field) => ({
        name: field.getAttribute("aria-label") ?? field.getAttribute("name") ?? field.id ?? field.tagName,
        px: parseFloat(getComputedStyle(field).fontSize),
      }))
      .filter(({ px }) => px < 16)
      .map(({ name, px }) => `${name} ${px}px`),
  );

const fontPx = (field: Locator): Promise<number> =>
  field.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));

async function expectNoZoomOnFocus(field: Locator): Promise<void> {
  await field.focus();
  await expect(field).toBeFocused();
  expect(await fontPx(field)).toBeGreaterThanOrEqual(16);
}

const openPalette = async (page: Page): Promise<Locator> => {
  await page.getByRole("button", { name: "Command palette" }).click();
  const command = page.getByRole("combobox", { name: "Command" });
  await expect(command).toBeFocused();
  return command;
};

const smallerText = async (page: Page): Promise<void> => {
  await (await openPalette(page)).fill("Smaller terminal text");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
};

for (const [name, device] of PHONES) {
  test.describe(name, () => {
    test.use({ ...device, serviceWorkers: "block" });

    test("the terminal's keyboard field stays at 16px at a small text size, and is on screen when first focused", async ({
      page,
    }) => {
      // The package parks its field at left: -9999px until it first places it at the cursor; a field focused off
      // screen can make a phone scroll or zoom to it. Seen as the focus arrives, before any handler of the field runs.
      await page.addInitScript(() => {
        document.addEventListener(
          "focusin",
          (event) => {
            const field = event.target;
            if (!(field instanceof HTMLTextAreaElement) || field.closest("[data-terminal]") === null) return;
            if (Reflect.has(window, "firstSinkFocus")) return;
            const box = field.getBoundingClientRect();
            Reflect.set(window, "firstSinkFocus", { left: box.left, right: box.right });
          },
          true,
        );
      });
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
      // The phone's default 13pt is 17.3px; at 10pt the field takes 13.3px through the package's `font: inherit`.
      await smallerText(page);
      await smallerText(page);
      await smallerText(page);
      await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
      const terminal = page.locator("[data-terminal]");
      await expect(terminal).toContainText("$", { timeout: 15_000 });
      expect(await fontPx(terminal)).toBeLessThan(16);

      await expectNoZoomOnFocus(terminal.locator("textarea"));
      const first = await page.evaluate(() => Reflect.get(window, "firstSinkFocus") as { left: number; right: number });
      expect(first.left).toBeGreaterThanOrEqual(0);
      expect(first.right).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
    });

    test("the Chat composer's field and the command palette do not zoom when focused", async ({ page }) => {
      await openPhoneTerminal(page);
      // The field the keys open is the Chat composer's (#2604).
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await expectNoZoomOnFocus(page.getByLabel("Type into the terminal"));
      await page.getByRole("button", { name: "Close chat" }).click();
      expect(await zoomingFields(page)).toEqual([]);

      await page.getByRole("button", { name: "Back to agents" }).click();
      const command = await openPalette(page);
      await expectNoZoomOnFocus(command);
      // The palette's field is `text-lg`: 18px on a phone, above the 16px floor, so the floor must leave it alone (#1401).
      expect(await fontPx(command)).toBe(18);
      expect(await zoomingFields(page)).toEqual([]);
    });

    test("find and rename do not zoom when focused", async ({ page }) => {
      const terminal = await openPhoneTerminal(page);
      await terminal.locator("textarea").focus();
      await pressShortcut(page, "terminal.search");
      await expectNoZoomOnFocus(page.getByRole("searchbox", { name: "Find in terminal" }));
      expect(await zoomingFields(page)).toEqual([]);
      await page.keyboard.press("Escape");

      await page
        .getByRole("banner")
        .getByRole("button", { name: /^Session actions for / })
        .click();
      await page.getByRole("button", { name: "Rename…", exact: true }).click();
      const rename = page.getByRole("dialog", { name: /^Rename / }).getByRole("textbox", { name: "Name" });
      await expectNoZoomOnFocus(rename);
      expect(await zoomingFields(page)).toEqual([]);
    });

    test("no field in Settings zooms when focused", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
      await (await openPalette(page)).fill("Open settings");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/settings$/);
      await expect(page.locator(TEXT_FIELDS).first()).toBeAttached();
      expect(await zoomingFields(page)).toEqual([]);
    });

    test("a double tap is two taps, not a zoom, and a pinch still zooms", async ({ page }) => {
      const terminal = await openPhoneTerminal(page);
      const surfaces: [string, Locator][] = [
        ["html", page.locator("html")],
        ["body", page.locator("body")],
        ["terminal", terminal],
        ["keys bar", keysBar(page)],
        ["a key", key(page, "Arrow keys")],
        ["a header button", page.getByRole("button", { name: "Back to agents" })],
      ];
      const actions = await Promise.all(
        surfaces.map(
          async ([label, target]) => `${label}: ${await target.evaluate((el) => getComputedStyle(el).touchAction)}`,
        ),
      );
      // #1396 keeps the terminal on `pan-y pinch-zoom` so one finger pans the scrollback and a pinch still zooms;
      // every other surface stays `manipulation`, where horizontal panning has nothing to move.
      expect(actions).toEqual(
        surfaces.map(([label]) => `${label}: ${label === "terminal" ? "pan-y pinch-zoom" : "manipulation"}`),
      );

      // `manipulation` keeps pinch-zoom; the viewport must not take it away either.
      const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
      expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)|maximum-scale/);
    });
  });
}
