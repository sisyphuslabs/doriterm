// A disabled Button is dimmed, yet its label stays legible against the fill it is painted on, in both themes and on
// every surface it sits on (#1031): 4.5:1 for a filled Button, 3:1 for a ghost one, measured as the browser composites
// it, opacity included. A working (loading) Button is busy, not unavailable, so it keeps its own colours.
import { PAIR_CODE, PAIRING_SETTINGS } from "./capture-relay.ts";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { newOn, OFFLINE_BOUND_MS, OFFLINE_TEST_TIMEOUT_MS, reconnect, switchTo } from "./machine-switch.ts";
import { measure, SURFACES } from "./painted-contrast.ts";

test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });

for (const theme of ["day", "night"] as const) {
  test.describe(`${theme}, 390 px`, () => {
    test.use({ colorScheme: theme === "day" ? "light" : "dark" });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(
        (chosen) => localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] })),
        theme,
      );
    });

    test("the invite entry's disabled Continue keeps a legible label on every surface, on a fill unlike the enabled one", async ({
      page,
    }) => {
      await page.addInitScript(
        (stored) => localStorage.setItem("doriface.connection", stored),
        JSON.stringify(PAIRING_SETTINGS),
      );
      await page.goto("/pair");
      const pair = page.getByRole("button", { name: "Continue", exact: true });
      await expect(pair).toBeDisabled();
      // Each measurement paints the parent and restores it inside one synchronous page call, so they cannot interleave.
      const everywhere = await Promise.all(
        [undefined, ...SURFACES].map((surface) => measure(page, pair, surface === undefined ? {} : { surface })),
      );
      for (const measured of everywhere) {
        expect(measured.ratio, measured.label).toBeGreaterThanOrEqual(4.5);
        expect(measured.fromEnabled, measured.label).toBeGreaterThanOrEqual(3);
      }
    });

    test("offline, the first-run's disabled Paste invite keeps a legible label", async ({ page, context }) => {
      await page.addInitScript(() => localStorage.removeItem("doriface.connection"));
      await page.goto("/");
      await context.setOffline(true);
      const button = page.getByRole("button", { name: "Paste invite" });
      await expect(button).toBeDisabled();
      const measured = await measure(page, button);
      await context.setOffline(false);
      expect(measured.ratio, measured.label).toBeGreaterThanOrEqual(4.5);
    });

    test("Continue keeps its primary colours while it looks the code up: it is working, not unavailable", async ({
      page,
    }) => {
      await page.addInitScript(
        (stored) => localStorage.setItem("doriface.connection", stored),
        JSON.stringify(PAIRING_SETTINGS),
      );
      // The lookup is never answered, so Continue stays busy for as long as the test looks at it.
      await page.route("https://relay-doriface.omo.dev/v1/pair/*", () => undefined);
      await page.goto("/pair");
      await page.getByLabel("Invite link or code").fill(PAIR_CODE);
      const pair = page.getByRole("button", { name: "Continue", exact: true });
      await pair.click();
      await expect(pair).toHaveAttribute("aria-busy", "true");
      const measured = await measure(page, pair, { svg: true });
      // Its fill is the enabled primary fill, and its spinner is drawn in the primary label colour on it.
      expect(measured.fromEnabled, measured.label).toBeLessThan(1.05);
      expect(measured.ratio, measured.label).toBeGreaterThanOrEqual(4.5);
    });
  });

  test.describe(`${theme}, 1440 px`, () => {
    test.use({ colorScheme: theme === "day" ? "light" : "dark", viewport: { width: 1440, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(
        (chosen) => localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] })),
        theme,
      );
    });
    test.afterEach(() => reconnect());

    test("an offline machine's New space icon is dimmed a visible step from the enabled one, still 3:1 on the sidebar", async ({
      page,
    }) => {
      test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
      await page.goto("/");
      const add = newOn(page);
      await expect(add).toBeEnabled({ timeout: 20_000 });
      const enabled = await measure(page, add, { svg: true });
      switchTo("drop");
      await expect(add, `${MACHINE_NAME} goes offline`).toBeDisabled({ timeout: OFFLINE_BOUND_MS });
      const disabled = await measure(page, add, { svg: true, enabled: enabled.ink });
      expect(disabled.ratio, disabled.label).toBeGreaterThanOrEqual(3);
      // The 3:1 floor caps how far a ghost glyph can dim (the enabled one is 5.3:1 to 7.3:1 on the sidebar).
      expect(disabled.step, disabled.label).toBeGreaterThanOrEqual(1.7);
      // The floor holds on every surface a ghost Button sits on, not only the sidebar it is measured in above (#1034).
      const everywhere = await Promise.all(SURFACES.map((surface) => measure(page, add, { svg: true, surface })));
      for (const measured of everywhere) expect(measured.ratio, measured.label).toBeGreaterThanOrEqual(3);
    });
  });
}
