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
