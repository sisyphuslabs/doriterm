import type { Page } from "@playwright/test";
import type { browserMeshFixture } from "./browser-mesh-fixture.ts";

export type Fixture = ReturnType<typeof browserMeshFixture>;

/** Memberships as a join leaves them: each one's keys under its slot (the default slot under plain names). */
export async function seedMeshes(
  page: Page,
  held: readonly { readonly fixture: Fixture; readonly slot: string }[],
): Promise<void> {
  await page.evaluate(async (seed) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("doriface", 1);
      request.addEventListener("upgradeneeded", () => request.result.createObjectStore("device"));
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("device", "readwrite");
      const store = transaction.objectStore("device");
      for (const { fixture, slot } of seed) {
        const prefix = slot === "" ? "" : `mesh-identity/${slot}/`;
        store.put({ kind: "raw", privateKey: new Uint8Array(fixture.cardSecret) }, `${prefix}mesh-sign-key`);
        store.put({ kind: "raw", privateKey: new Uint8Array(fixture.deviceSecret) }, `${prefix}device-key`);
      }
      const memberships = seed.map(({ fixture, slot }) => ({ ...fixture.membership, keySlot: slot }));
      store.put({ version: 1, memberships, slots: [] }, "mesh-memberships");
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => reject(transaction.error));
    });
    db.close();
  }, held);
}

/** Two meshes held side by side (#2861): the first on the browser's default keys, the second on keys of its own slot. */
export const seedTwoMeshes = (page: Page, first: Fixture, second: Fixture): Promise<void> =>
  seedMeshes(page, [
    { fixture: first, slot: "" },
    { fixture: second, slot: "second" },
  ]);

export async function stored(page: Page, key: string): Promise<unknown> {
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

/** The meshes the stored record holds, by id, as a list (or what is stored when it is not a record). */
export async function storedMeshes(page: Page): Promise<unknown> {
  const list: unknown = Reflect.get(Object(await stored(page, "mesh-memberships")), "memberships");
  return Array.isArray(list) ? list.map((held) => Reflect.get(Object(held), "meshId")) : list;
}
