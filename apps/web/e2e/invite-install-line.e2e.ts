import { expect, test } from "./fixtures.ts";
import { startFakeRelayHost } from "./relay-route.ts";

test.use({ serviceWorkers: "block" });

// #2795: the whole install line pasted into "Invite link or code" read its trailing `>' sh` as part of the link, so a
// mesh invite became a device pairing the host refused as "used already or replaced".
test("pasting the whole install line opens the mesh invite it carries", async ({ page }) => {
  const host = await startFakeRelayHost({});
  try {
    await host.route(page);
    const { link } = await host.meshOffer();
    await page.addInitScript(() => localStorage.removeItem("doriface.connection"));
    await page.goto("/pair");
    await expect(page.getByRole("heading", { name: "Join a mesh" })).toBeVisible({ timeout: 15_000 });
    const line = `curl -fsSL https://get.doriterm.com | DORIFACE_JOIN='<${link}>' sh`;
    await page.getByLabel("Invite link or code").fill(line);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Join this mesh", exact: true })).toBeVisible({ timeout: 30_000 });
  } finally {
    await host.stop();
  }
});
