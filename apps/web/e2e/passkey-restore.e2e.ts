import { mergeAtDoor, viewOf } from "@doriface/mesh";
import { expect, test } from "@playwright/test";
import { at, ios, passkey, restoredMemberships, restorePartition } from "./passkey-restore-fixture.ts";
import { seedMeshes } from "./two-meshes-page.ts";

test("an empty Home Screen app offers passkey restore as well as a new invite", async ({ page }) => {
  await page.addInitScript((agent) => {
    Object.defineProperty(Navigator.prototype, "userAgent", { configurable: true, get: () => agent });
  }, ios);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Restore with a passkey", exact: true })).toBeVisible();
  await expect(page.getByText("Join a mesh", { exact: true }).first()).toBeVisible();
});

test("the superseded device shows when its identity was replaced by a restore", async ({ page }) => {
  const { old } = restoredMemberships();
  await page.routeWebSocket(/.*/, (socket) => socket.close({ code: 4404, reason: "fixture offline" }));
  await page.goto("/");
  await seedMeshes(page, [{ fixture: old, slot: "" }]);
  await page.reload();
  await expect(page.getByText("This device was replaced by a restore")).toBeVisible();
  await expect(page.locator(`time[datetime="${new Date(at).toISOString()}"]`)).toBeVisible();
});

test("a different member sees the restore notification, timed member row, and revoke action", async ({ page }) => {
  const { observer } = restoredMemberships();
  await page.routeWebSocket(/.*/, (socket) => socket.close({ code: 4404, reason: "fixture offline" }));
  await page.goto("/");
  await seedMeshes(page, [{ fixture: observer, slot: "" }]);
  await page.goto("/settings#machines");
  await expect(page.getByText("my-browser was restored on a new device")).toBeVisible();
  const group = page.getByRole("region", { name: "Browsers and phones" });
  await expect(group.getByText(/Readmitted at/)).toBeVisible();
  await expect(group.getByRole("button", { name: "Copy the command that removes my-browser" })).toBeVisible();
});

test("two cleared apps restoring across a holder partition lose both successors at convergence", async ({
  browser,
  baseURL,
}) => {
  const partition = await restorePartition();
  const pages = await Promise.all(
    partition.holders.map(async (holder) => {
      const page = await browser.newPage({ ...(baseURL === undefined ? {} : { baseURL }), serviceWorkers: "block" });
      await holder.connect(page);
      await passkey(page, partition.locator);
      return page;
    }),
  );
  try {
    await Promise.all(
      pages.map(async (page) => {
        await page.goto("/");
        await page.getByRole("button", { name: "Restore with a passkey" }).click();
        // Declining assertion 2 does not undo the admission on this side of the partition.
        await expect(page.getByText("Device restored. Passkey restore is off.")).toBeVisible({ timeout: 20_000 });
      }),
    );
    const original = partition.records;
    const proofs = (await Promise.all(partition.holders.map((h) => h.records()))).flatMap((records) =>
      records.slice(original.length),
    );
    expect(proofs).toHaveLength(2);
    for (const order of [proofs, proofs.toReversed()]) {
      const valid = mergeAtDoor(original, [], order);
      expect(valid.added).toHaveLength(2);
      const view = viewOf(valid.stored);
      expect(view.members.size).toBe(2);
      expect([...view.revoked]).toEqual([partition.old]);
    }
  } finally {
    await Promise.all(pages.map((page) => page.close()));
    await partition.clean();
  }
});
