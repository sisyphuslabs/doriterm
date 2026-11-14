// A disabled Input, NumberStepper, Switch and menu item dim with their own tokens, never with a fade over the whole
// control, so their text stays at 4.5:1 and the parts that carry meaning at 3:1, in both themes (#1034), and each is
// still a visible step from the same control enabled.
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { measure, tokenStep } from "./painted-contrast.ts";

/**
 * A disabled button's glyph measured against the same button with its disabled marks lifted, which paints the enabled
 * glyph, as a control at its bound sits beside its enabled neighbour: the step is the one the tokens hold (--muted-foreground
 * to --disabled-glyph), the Button spec's 1.7 where the glyph floor leaves room and less where it does not (#1241, #2513).
 */
async function disabledGlyph(page: Page, button: Locator): ReturnType<typeof measure> {
  const marks = await button.evaluate((element) =>
    ["disabled", "data-disabled", "aria-disabled"].flatMap((name) => {
      const value = element.getAttribute(name);
      return value === null ? [] : [[name, value] as const];
    }),
  );
  await button.evaluate((element, names) => {
    for (const [name] of names) element.removeAttribute(name);
  }, marks);
  const enabled = await measure(page, button, { svg: true });
  await button.evaluate((element, names) => {
    for (const [name, value] of names) element.setAttribute(name, value);
  }, marks);
  return measure(page, button, { svg: true, enabled: enabled.ink });
}

const BROKEN_STORAGE = `IDBFactory.prototype.open = () => { throw new DOMException("IndexedDB is not available here", "InvalidStateError"); };`;

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });

for (const theme of ["day", "night"] as const) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme === "day" ? "light" : "dark" });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(
        (chosen) => localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] })),
        theme,
      );
    });

    test("with terminal settings unreadable, the disabled field, stepper and switches stay legible", async ({
      page,
    }) => {
      await page.addInitScript({ content: BROKEN_STORAGE });
      await page.goto("/settings");
      await page
        .getByRole("tab", { name: "Terminal" })
        .or(page.getByRole("button", { name: "Terminal" }))
        .first()
        .click();
      await expect(page.getByRole("alert").filter({ hasText: "Terminal settings could not be read" })).toBeVisible();
      const controls = {
        "cursor-color": page.getByRole("textbox", { name: "cursor-color", exact: true }),
        "font-size": page.getByRole("button", { name: "Increase font-size" }).locator(".."),
        "link-url": page.getByRole("switch", { name: "link-url", exact: true }),
        "font-thicken": page.getByRole("switch", { name: "font-thicken", exact: true }),
      };
      for (const [key, control] of Object.entries(controls)) {
        // oxlint-disable-next-line no-await-in-loop -- one control scrolled into view and shot at a time
        await control.screenshot({ path: test.info().outputPath(`${theme}-${key}.png`) });
      }

      const search = page.getByRole("searchbox", { name: "Search terminal settings" });
      const field = page.getByRole("textbox", { name: "cursor-color", exact: true });
      await expect(field).toBeDisabled();
      const enabledInk = (await measure(page, search, { part: { selector: "", paint: "color" } })).ink;
      const text = await measure(page, field, { part: { selector: "", paint: "color" }, enabled: enabledInk });
      expect(text.ratio, text.label).toBeGreaterThanOrEqual(4.5);
      expect(text.step, text.label).toBeGreaterThanOrEqual(1.5);

      const increase = page.getByRole("button", { name: "Increase font-size" });
      await expect(increase).toBeDisabled();
      const glyph = await disabledGlyph(page, increase);
      expect(glyph.ratio, glyph.label).toBeGreaterThanOrEqual(3);
      expect(glyph.step, glyph.label).toBeGreaterThanOrEqual((await tokenStep(page)) * 0.97);

      // A ghost icon button (IconButton's default), disabled with the settings: its icon paints --disabled-glyph (#1897).
      const add = page.getByRole("button", { name: /^Add / }).first();
      await expect(add).toBeDisabled();
      const icon = await disabledGlyph(page, add);
      expect(icon.ratio, icon.label).toBeGreaterThanOrEqual(3);
      expect(icon.step, icon.label).toBeGreaterThanOrEqual((await tokenStep(page)) * 0.97);
      const value = await measure(page, page.getByRole("textbox", { name: "font-size", exact: true }), {
        part: { selector: "", paint: "color" },
      });
      expect(value.ratio, value.label).toBeGreaterThanOrEqual(4.5);

      // link-url is on by default and font-thicken off: the thumb is told from its track in both positions.
      const toggles = ["link-url", "font-thicken"].map((name) => page.getByRole("switch", { name, exact: true }));
      await Promise.all(toggles.map((toggle) => expect(toggle).toBeDisabled()));
      const thumbs = await Promise.all(
        toggles.map((toggle) => measure(page, toggle, { part: { selector: "span", paint: "background" } })),
      );
      for (const thumb of thumbs) expect(thumb.ratio, thumb.label).toBeGreaterThanOrEqual(3);
    });

    test("a disabled menu item's label stays legible on the menu", async ({ page }) => {
      await page.goto("/");
      const newTab = page.getByRole("button", { name: "New tab", exact: true });
      await expect(newTab).toBeVisible({ timeout: 20_000 });
      await newTab.click();
      const item = page.getByRole("menuitem", { name: /^Terminal/ });
      await expect(item).toBeVisible();
      const enabled = await measure(page, item);
      // Base UI marks a disabled item with these two attributes; the item's styles read nothing else.
      await item.evaluate((element) => {
        element.setAttribute("data-disabled", "");
        element.setAttribute("aria-disabled", "true");
      });
      const disabled = await measure(page, item, { enabled: enabled.ink });
      await page.getByRole("menu").screenshot({ path: test.info().outputPath(`${theme}-menu.png`) });
      expect(disabled.ratio, disabled.label).toBeGreaterThanOrEqual(4.5);
      expect(disabled.step, disabled.label).toBeGreaterThanOrEqual(1.5);
      // A disabled item stays reachable by the arrow keys (Base UI keeps it focusable), and highlighted it sits on the
      // row's hover wash: its label still holds 4.5:1 there (#2513 review).
      await item.evaluate((element) => element.setAttribute("data-highlighted", ""));
      const highlighted = await measure(page, item);
      expect(highlighted.ratio, `highlighted ${highlighted.label}`).toBeGreaterThanOrEqual(4.5);
    });
  });
}
