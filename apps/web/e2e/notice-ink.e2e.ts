// The words under an error notice's title sit on its red wash, so they are the foreground at reduced alpha, which
// takes on the wash, never a neutral gray painted over it, and they keep 4.5:1 in both themes (#1496).
import { PAIRING_SETTINGS } from "./capture-relay.ts";
import { SHOTS } from "./capture-shots.ts";
import { expect, test } from "./fixtures.ts";
import { measure } from "./painted-contrast.ts";

const BROKEN_STORAGE = `IDBFactory.prototype.open = () => { throw new DOMException("IndexedDB is not available here", "InvalidStateError"); };`;

const channels = (css: string) => (css.match(/[\d.]+/g) ?? []).map(Number);

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });

for (const theme of ["day", "night"] as const) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme === "day" ? "light" : "dark" });

    for (const name of ["pair-refused-4410", "storage-error"] as const) {
      test(`${name}: the error notice's body is the foreground ink on its wash, at 4.5:1`, async ({ page }) => {
        await page.addInitScript(
          (chosen) => localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] })),
          theme,
        );
        if (name === "pair-refused-4410")
          await page.addInitScript(
            (stored) => localStorage.setItem("doriface.connection", stored),
            JSON.stringify(PAIRING_SETTINGS),
          );
        else await page.addInitScript({ content: BROKEN_STORAGE });
        const shot = SHOTS.find((entry) => entry.name === name);
        if (shot === undefined) throw new Error(`capture ${name} is missing`);
        await shot.run(page, "1440");
        const notice = page.getByRole("alert").first();
        const body = notice.locator("p + div");
        await expect(body).toBeVisible();
        const [ink, foreground] = await body.evaluate((element) => {
          const probe = document.createElement("span");
          // The same colour space a Tailwind alpha modifier computes to, so the two compare channel by channel.
          probe.style.color = "color-mix(in oklab, var(--foreground), transparent 0%)";
          element.append(probe);
          const colours = [getComputedStyle(element).color, getComputedStyle(probe).color];
          probe.remove();
          return colours;
        });
        const [l = 0, a = 0, b = 0, alpha = 1] = channels(ink ?? "");
        const [fl = 1, fa = 1, fb = 1] = channels(foreground ?? "");
        for (const [mine, theirs] of [
          [l, fl],
          [a, fa],
          [b, fb],
        ] as const)
          expect(mine, `${ink} is the foreground ${foreground}`).toBeCloseTo(theirs, 3);
        expect(alpha, `${ink} is translucent, so it takes on the wash`).toBeLessThan(1);
        const painted = await measure(page, notice, { part: { selector: "p + div", paint: "color" } });
        expect(painted.ratio, painted.label).toBeGreaterThanOrEqual(4.5);
      });
    }
  });
}
