import { devices, type Page } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { drawnUnderSettings } from "./under-settings.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

/** A row's pin mark, its More, and its Pin or Unpin, by attribute: the workspace under Settings is aria-hidden. */
const ROW_CONTROLS = [
  '[aria-label="Pinned"]',
  '[aria-label^="More for "]',
  '[aria-label^="Pin "]',
  '[aria-label^="Unpin "]',
];

/** Every row control the workspace lays out: its centre where it is now, and whether it is drawn there. */
const rowControls = (page: Page) =>
  page.locator(ROW_CONTROLS.join(", ")).evaluateAll((elements) =>
    elements.flatMap((element) => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return [];
      return [
        {
          label: element.getAttribute("aria-label") ?? "",
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
          drawn: getComputedStyle(element).visibility !== "hidden",
        },
      ];
    }),
  );

const pinFromMore = async (page: Page, name: string) => {
  await expect(page.getByRole("button", { name: `More for ${name}` })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: `More for ${name}` }).tap();
  await page.getByRole("menuitem", { name: "Pin to top" }).tap();
};

/** For each point, whether a tap there lands in the Settings sheet. */
const tapsReachSettings = (page: Page, points: readonly { readonly x: number; readonly y: number }[]) =>
  page.evaluate(
    (at) => at.map(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-settings-sheet]") != null),
    points,
  );

// The report: on a phone, an agent row's pin was still drawn with Settings open. A pinned row draws a pin mark of its
// own, and a blocked one its chip, beside the More a touch screen always shows (#808, #950); none of them may be drawn
// over Settings, in either theme, and a tap at any of them must reach Settings, not the list under it.
for (const scheme of ["light", "dark"] as const) {
  test(`with Settings open on a phone, a pinned and a blocked agent draw no pin or More over it (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const names = [`pinidle${scheme}`, `pinblocked${scheme}`] as const;
    const addresses = [startAgent("host", names[0], "idle"), startAgent("host", names[1], "blocked")];
    try {
      await page.goto("/");
      await pinFromMore(page, names[0]);
      await pinFromMore(page, names[1]);
      await expect(page.getByRole("img", { name: "Pinned" })).toHaveCount(2);

      await page
        .getByRole("link", { name: /Settings/ })
        .or(page.getByRole("button", { name: /Settings/ }))
        .first()
        .click();
      await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();

      await expect.poll(() => drawnUnderSettings(page)).toEqual([]);
      // Measured with Settings open, where the rows are laid out under it: none of their controls is drawn, and a tap at
      // each lands in Settings.
      const controls = await rowControls(page);
      expect(controls.map((control) => control.label)).toEqual(
        expect.arrayContaining(["Pinned", "Pinned", ...names.map((name) => `More for ${name}`)]),
      );
      expect(controls.filter((control) => control.drawn).map((control) => control.label)).toEqual([]);
      expect(await tapsReachSettings(page, controls)).toEqual(controls.map(() => true));
    } finally {
      for (const address of addresses) endAgent("host", address);
    }
  });
}
