// #2939: one place to connect anything. A phone or browser gets an invite as a QR and an https link it can open; the
// link it gives is the hosted app's join page, never the desktop app's own scheme, which a phone cannot open.
import { expect, test } from "./fixtures.ts";

test("Connect a device opens on a phone or browser invite: a QR and an https link that opens Join this mesh", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto("/");
  const footer = page.getByRole("complementary", { name: "Workspace" }).locator('[data-slot="sidebar-footer"]');
  await footer.getByRole("button", { name: "Connect a device" }).click({ timeout: 60_000 });
  const dialog = page.getByRole("dialog", { name: "Connect a device" });
  await expect(dialog.getByRole("img", { name: "Invite QR code" })).toBeVisible({ timeout: 20_000 });
  const link = (await dialog.getByLabel("Invite link").textContent()) ?? "";
  expect(link).toMatch(/^https:\/\/[^/]+\/pair#.*m=1/);
  // The link's own page is the hosted app; this run serves the app locally, so the fragment is opened here.
  const phone = await browser.newContext(baseURL === undefined ? {} : { baseURL });
  try {
    const opened = await phone.newPage();
    await opened.goto(`/pair${link.slice(link.indexOf("#"))}`);
    await expect(opened.getByRole("heading", { name: "Join this mesh" })).toBeVisible({ timeout: 20_000 });
  } finally {
    await phone.close();
  }
});

// The sheet on a phone (#2949 review): a computer's tab is the tallest; it stays a bounded scroller inside the viewport,
// and its Done stays reachable at the end, at 390 and at 320.
for (const width of [390, 320] as const) {
  test(`at ${width} the Computer tab stays inside the screen and its Done stays in view`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/settings#machines");
    await page.getByRole("button", { name: "Connect a device" }).first().click({ timeout: 60_000 });
    const dialog = page.getByRole("dialog", { name: "Connect a device" });
    await dialog.getByRole("button", { name: "Computer", exact: true }).click();
    await expect(dialog.getByLabel("Join command")).toBeVisible({ timeout: 20_000 });
    const box = await dialog.boundingBox();
    expect(
      box === null ? "no box" : box.y >= 0 && box.y + box.height <= 844 && box.x >= 0 && box.x + box.width <= width,
    ).toBe(true);
    await dialog.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect(dialog.getByRole("button", { name: "Done" })).toBeInViewport();
  });
}

// #2949 review: a phone invite, then the Computer tab at once. Both tabs ask for an offer through one document; the
// computer's request must win and show its command, never "No join command" or a phone request answered instead.
test("asking for a phone invite and then a computer's command shows the command", async ({ page }) => {
  await page.goto("/");
  const footer = page.getByRole("complementary", { name: "Workspace" }).locator('[data-slot="sidebar-footer"]');
  await footer.getByRole("button", { name: "Connect a device" }).click({ timeout: 60_000 });
  const dialog = page.getByRole("dialog", { name: "Connect a device" });
  await expect(dialog.getByRole("img", { name: "Invite QR code" })).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole("button", { name: "Computer", exact: true }).click();
  await expect(dialog.getByLabel("Join command")).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText("No join command")).toHaveCount(0);
});
