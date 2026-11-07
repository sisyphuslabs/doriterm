import { devices, type Page } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

/** Every element of the workspace kept under Settings (#607) whose own computed visibility would paint it. */
const drawnUnderSettings = (page: Page) =>
  page
    .locator("[inert] *")
    .evaluateAll((elements) =>
      elements
        .filter((element) => getComputedStyle(element).visibility !== "hidden")
        .map((element) => element.getAttribute("aria-label") ?? element.tagName.toLowerCase()),
    );

const rowControls = (page: Page) =>
  page.locator('[aria-label="Pinned"], [aria-label^="More for "]').evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { label: element.getAttribute("aria-label") ?? "", x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }),
  );

const pinFromMore = async (page: Page, name: string) => {
  await expect(page.getByRole("button", { name: `More for ${name}` })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: `More for ${name}` }).tap();
  await page.getByRole("menuitem", { name: "Pin to top" }).tap();
};

const tapsReachWorkspace = (page: Page, points: readonly { readonly x: number; readonly y: number }[]) =>
  page.evaluate((at) => at.map(({ x, y }) => document.elementFromPoint(x, y)?.closest("[inert]") != null), points);

// The report: on a phone, an agent row's pin was still drawn with Settings open. A pinned row draws a pin mark of its
// own, and a blocked one its chip, beside the More a touch screen always shows (#808, #950); none of them may be drawn
// over Settings, in either theme, and a tap where they were must reach Settings, not the list under it.
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
      const controls = await rowControls(page);
      expect(controls.map((control) => control.label)).toEqual(
        expect.arrayContaining(["Pinned", "Pinned", ...names.map((name) => `More for ${name}`)]),
      );

      await page
        .getByRole("link", { name: /Settings/ })
        .or(page.getByRole("button", { name: /Settings/ }))
        .first()
        .click();
      await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();

      await expect.poll(() => drawnUnderSettings(page)).toEqual([]);
      // By attribute, not by role: the workspace under Settings is aria-hidden, so a role query could never fail.
      await expect(page.locator('[aria-label="Pinned"]:visible, [aria-label^="More for "]:visible')).toHaveCount(0);
      await expect(page.locator('button[aria-label^="Pin "]:visible')).toHaveCount(0);
      expect(await tapsReachWorkspace(page, controls)).toEqual(controls.map(() => false));
    } finally {
      for (const address of addresses) endAgent("host", address);
    }
  });
}
