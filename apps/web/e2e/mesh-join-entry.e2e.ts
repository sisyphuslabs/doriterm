import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`an empty browser offers a mesh invite at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Join a mesh", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Paste invite", exact: true })).toBeVisible();
    await expect(page.getByLabel("Invite link or code")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`join-entry-${width}.png`), fullPage: true });
  });
}

test("a standalone app's empty partition offers Paste invite", async ({ page }) => {
  await page.addInitScript(() => {
    const actual = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const result = actual(query);
      if (query === "(display-mode: standalone)") Object.defineProperty(result, "matches", { value: true });
      return result;
    };
    Object.defineProperty(navigator, "standalone", { value: true });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Join a mesh", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Paste invite", exact: true })).toBeVisible();
});
