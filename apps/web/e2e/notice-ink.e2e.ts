// The words under an error notice's title sit on its red wash, so they are the foreground at reduced alpha, which
// takes on the wash, never a neutral gray painted over it, and they keep 4.5:1 in both themes (#1496).
import { PAIRING_SETTINGS } from "./capture-relay.ts";
import { SHOTS } from "./capture-shots.ts";
import { expect, test } from "./fixtures.ts";
import { measure } from "./painted-contrast.ts";

const BROKEN_STORAGE = `IDBFactory.prototype.open = () => { throw new DOMException("IndexedDB is not available here", "InvalidStateError"); };`;

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
        // The contrast first, as a soft check, so a run that fails on the colour below still shows what the ink scored.
        const painted = await measure(page, notice, { part: { selector: "p + div", paint: "color" } });
        const contrast = `${painted.label} at ${painted.ratio.toFixed(2)}:1`;
        test.info().annotations.push({ type: "contrast", description: contrast });
        expect.soft(painted.ratio, contrast).toBeGreaterThanOrEqual(4.5);
        // Both colours painted onto a clear canvas and read back as sRGB bytes, so they compare in one space whatever
        // syntax the stylesheet serialises them in.
        const [ink, foreground] = await body.evaluate((element) => {
          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          const paint = canvas.getContext("2d", { willReadFrequently: true });
          if (paint === null) throw new Error("no 2d canvas");
          const srgb = (css: string): number[] => {
            paint.clearRect(0, 0, 1, 1);
            // A canvas that cannot parse a colour silently keeps its previous fill, so each assignment starts from a
            // sentinel and fails loudly if the sentinel survives. A second sentinel covers a colour that is the first.
            const accepted = ["#010203", "#040506"].some((sentinel) => {
              paint.fillStyle = sentinel;
              paint.fillStyle = css;
              return paint.fillStyle !== sentinel;
            });
            if (!accepted) throw new Error(`the canvas rejected the colour "${css}"`);
            paint.fillRect(0, 0, 1, 1);
            return [...paint.getImageData(0, 0, 1, 1).data];
          };
          const probe = document.createElement("span");
          probe.style.color = "var(--foreground)";
          element.append(probe);
          const colours = [srgb(getComputedStyle(element).color), srgb(getComputedStyle(probe).color)];
          probe.remove();
          return colours;
        });
        const [r = 0, g = 0, b = 0, alpha = 255] = ink ?? [];
        const [fr = 255, fg = 255, fb = 255] = foreground ?? [];
        const named = `rgba(${ink?.join(", ")}) is the foreground rgb(${foreground?.slice(0, 3).join(", ")}); ${contrast}`;
        // Unpremultiplying 8-bit bytes at a partial alpha rounds each channel by a step or two.
        for (const [mine, theirs] of [
          [r, fr],
          [g, fg],
          [b, fb],
        ] as const)
          expect(Math.abs(mine - theirs), named).toBeLessThanOrEqual(2);
        expect(alpha, `${named}; it is translucent, so it takes on the wash`).toBeLessThan(255);
      });
    }
  });
}
