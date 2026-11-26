import { expect, test, type Page } from "@playwright/test";
import { browserMeshFixture } from "./browser-mesh-fixture.ts";

type Fixture = ReturnType<typeof browserMeshFixture>;

/** Two meshes held side by side (#2861): the first on the browser's default keys, the second on keys of its own slot. */
async function seedTwoMeshes(page: Page, first: Fixture, second: Fixture): Promise<void> {
  await page.evaluate(
    async (seed) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("doriface", 1);
        request.addEventListener("upgradeneeded", () => request.result.createObjectStore("device"));
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("device", "readwrite");
        const store = transaction.objectStore("device");
        store.put({ kind: "raw", privateKey: new Uint8Array(seed.first.cardSecret) }, "mesh-sign-key");
        store.put({ kind: "raw", privateKey: new Uint8Array(seed.first.deviceSecret) }, "device-key");
        store.put(
          { kind: "raw", privateKey: new Uint8Array(seed.second.cardSecret) },
          "mesh-identity/second/mesh-sign-key",
        );
        store.put(
          { kind: "raw", privateKey: new Uint8Array(seed.second.deviceSecret) },
          "mesh-identity/second/device-key",
        );
        store.put(
          [
            { ...seed.first.membership, keySlot: "" },
            { ...seed.second.membership, keySlot: "second" },
          ],
          "mesh-memberships",
        );
        transaction.addEventListener("complete", () => resolve());
        transaction.addEventListener("abort", () => reject(transaction.error));
      });
      db.close();
    },
    { first, second },
  );
}

async function stored(page: Page, key: string): Promise<unknown> {
  return page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("doriface", 1);
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction("device").objectStore("device").get(name);
        request.addEventListener("success", () => resolve(request.result ?? null));
        request.addEventListener("error", () => reject(request.error));
      });
    } finally {
      db.close();
    }
  }, key);
}

const machinesTab = (page: Page) =>
  page
    .getByRole("tab", { name: "Machines", exact: true })
    .or(page.getByRole("button", { name: "Machines", exact: true }))
    .first();

test("a browser in two meshes names each machine's mesh, and forgetting one keeps the other", async ({ page }) => {
  const first = browserMeshFixture();
  const second = browserMeshFixture();
  await page.routeWebSocket(/.*/, (socket) => socket.close({ code: 4404, reason: "fixture offline" }));
  await page.goto("/");
  await seedTwoMeshes(page, first, second);
  await page.goto("/settings");

  const meshes = page.getByRole("list", { name: "Meshes", exact: true });
  await expect(meshes.getByRole("listitem")).toHaveCount(2);
  await expect(meshes).toContainText(`Mesh ${first.membership.meshId}`);
  await expect(meshes).toContainText(`Mesh ${second.membership.meshId}`);
  await expect(meshes.getByText("In view", { exact: true })).toHaveCount(1);
  await expect(page.getByText(`Member of ${first.membership.meshId} · 0 machines online`)).toBeVisible();

  await machinesTab(page).click();
  const machines = page.getByRole("list", { name: "Machines", exact: true });
  await expect(machines.getByRole("listitem")).toHaveCount(4);
  await expect(machines.getByText(`Mesh ${first.membership.meshId}`, { exact: true })).toHaveCount(2);
  await expect(machines.getByText(`Mesh ${second.membership.meshId}`, { exact: true })).toHaveCount(2);

  await page.goto("/settings");
  await meshes.getByRole("listitem").filter({ hasText: second.membership.meshId }).getByRole("button").click();
  await expect(page.getByText(`Member of ${second.membership.meshId} · 0 machines online`)).toBeVisible();
  await page.getByRole("button", { name: "Leave this mesh", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Leave this mesh", exact: true }).click();
  await page.getByRole("button", { name: "Forget this mesh here", exact: true }).click();

  await expect(page.getByText(`Member of ${first.membership.meshId} · 0 machines online`)).toBeVisible();
  await expect(page.getByRole("list", { name: "Meshes", exact: true })).toHaveCount(0);
  await expect
    .poll(async () => {
      const list = await stored(page, "mesh-memberships");
      return Array.isArray(list) ? list.map((held) => Reflect.get(Object(held), "meshId")) : list;
    })
    .toEqual([first.membership.meshId]);
  expect(await stored(page, "mesh-identity/second/mesh-sign-key")).toBeNull();
  expect(await stored(page, "mesh-sign-key")).not.toBeNull();
});
