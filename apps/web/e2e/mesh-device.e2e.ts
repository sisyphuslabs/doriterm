import { expect, test, devices } from "@playwright/test";
import { browserMeshFixture } from "./browser-mesh-fixture.ts";

for (const phone of [false, true]) {
  test(`joined ${phone ? "phone" : "desktop"} owns its device and lists every machine`, async ({
    browser,
    baseURL,
  }, info) => {
    const context = await browser.newContext({
      ...(phone ? devices["iPhone 14"] : { viewport: { width: 1440, height: 900 } }),
      ...(baseURL === undefined ? {} : { baseURL }),
    });
    try {
      const page = await context.newPage();
      await page.routeWebSocket(/.*/, (socket) => socket.close({ code: 4404, reason: "fixture offline" }));
      await page.goto("/");
      await page.evaluate(async (fixture) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("doriface", 1);
          request.addEventListener("upgradeneeded", () => request.result.createObjectStore("device"));
          request.addEventListener("success", () => resolve(request.result));
          request.addEventListener("error", () => reject(request.error));
        });
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction("device", "readwrite");
          const store = transaction.objectStore("device");
          store.put({ kind: "raw", privateKey: new Uint8Array(fixture.cardSecret) }, "mesh-sign-key");
          store.put({ kind: "raw", privateKey: new Uint8Array(fixture.deviceSecret) }, "device-key");
          store.put(fixture.membership, "mesh-membership");
          transaction.addEventListener("complete", () => resolve());
          transaction.addEventListener("abort", () => reject(transaction.error));
        });
        db.close();
      }, browserMeshFixture());
      await page.goto("/settings");
      await expect(page.getByText("my-browser", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Host", exact: true })).toHaveCount(0);
      await expect(page.getByText("This machine", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Leave this mesh", exact: true })).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`this-device-${phone ? "phone" : "desktop"}.png`),
        fullPage: true,
      });
      await page
        .getByRole("tab", { name: "Machines", exact: true })
        .or(page.getByRole("button", { name: "Machines", exact: true }))
        .first()
        .click();
      await expect(page.getByRole("list", { name: "Machines", exact: true })).toContainText("studio");
      await expect(page.getByRole("list", { name: "Machines", exact: true })).toContainText("workshop");
      await expect(page.getByText("my-browser (this browser)", { exact: true })).toBeVisible();
      await expect(page.getByText("This machine", { exact: true })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`machines-${phone ? "phone" : "desktop"}.png`), fullPage: true });
      await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("doriface", 1);
          request.addEventListener("success", () => resolve(request.result));
          request.addEventListener("error", () => reject(request.error));
        });
        try {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("device", "readwrite");
            tx.objectStore("device").put(
              { kind: "webcrypto", privateKey: null, publicKey: new Uint8Array(32) },
              "device-key",
            );
            tx.addEventListener("complete", () => resolve());
            tx.addEventListener("abort", () => reject(tx.error));
          });
        } finally {
          db.close();
        }
      });
      await page.goto("/");
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open("doriface", 1);
              request.addEventListener("success", () => resolve(request.result));
              request.addEventListener("error", () => reject(request.error));
            });
            try {
              return await new Promise<unknown>((resolve, reject) => {
                const request = db.transaction("device").objectStore("device").get("mesh-membership");
                request.addEventListener("success", () => resolve(request.result ?? null));
                request.addEventListener("error", () => reject(request.error));
              });
            } finally {
              db.close();
            }
          }),
        )
        .toBeNull();
      await expect(page.getByRole("heading", { name: "Join a mesh", exact: true })).toBeVisible();
      await expect(page.getByText("This browser was removed from the mesh", { exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}
