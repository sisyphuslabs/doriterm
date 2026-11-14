// The sidebar's own disabled controls follow the ghost Button's rule (#1243): an offline machine's "New space there" row
// keeps its label at 4.5:1 and its icon at 3:1, and its header's icon, dimmed while it has no terminal to open, keeps
// 3:1 a visible step below its name, each measured as the browser composites it, opacity included, and each a visible step from the ink it
// has undimmed. A fade over the whole row would fade its label with it.
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { machineRow, OFFLINE_BOUND_MS, OFFLINE_TEST_TIMEOUT_MS, reconnect, switchTo } from "./machine-switch.ts";
import { measure } from "./painted-contrast.ts";

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
    test.afterEach(() => reconnect());

    test("an offline machine's New space there and its header icon stay legible, a visible step below enabled", async ({
      page,
    }) => {
      test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
      await page.goto("/");
      const group = page
        .getByRole("complementary", { name: "Workspace" })
        .getByRole("region", { name: MACHINE_NAME, exact: true });
      const there = group.getByRole("button", { name: "New space there" });
      const header = machineRow(page);
      await expect(there).toBeEnabled({ timeout: 20_000 });
      const label = await measure(page, there);
      const icon = await measure(page, there, { svg: true });
      // The machine has no terminal of its own to open, so its header dims its icon; undimmed, the icon is drawn in the
      // ink its name keeps.
      await expect(header).toHaveAttribute("aria-disabled", "true");
      const headerName = await measure(page, header);

      switchTo("drop");
      await expect(there, `${MACHINE_NAME} goes offline`).toBeDisabled({ timeout: OFFLINE_BOUND_MS });
      await group.screenshot({ path: test.info().outputPath(`${theme}-offline-machine.png`) });
      const parts = [
        // A disabled label reads as unavailable at a glance: about twice as faint as enabled, the most its 4.5:1 floor on
        // --raised leaves in night (#2510). The icons keep the Button spec's step.
        {
          name: "New space there label",
          min: 4.5,
          minStep: 1.95,
          ...(await measure(page, there, { enabled: label.ink })),
        },
        {
          name: "New space there icon",
          min: 3,
          minStep: 1.5,
          ...(await measure(page, there, { svg: true, enabled: icon.ink })),
        },
        {
          name: "header icon",
          min: 3,
          minStep: 1.5,
          ...(await measure(page, header, { svg: true, enabled: headerName.ink })),
        },
      ];
      for (const part of parts) {
        const said = `${theme} ${part.name}: ${part.label}, ${part.ratio.toFixed(2)}:1, step ${part.step.toFixed(2)}`;
        console.log(said);
        expect.soft(part.ratio, said).toBeGreaterThanOrEqual(part.min);
        expect.soft(part.step, said).toBeGreaterThanOrEqual(part.minStep);
      }
    });
  });
}
