import { expect, test, devices } from "@playwright/test";
import { browserMeshFixture } from "./browser-mesh-fixture.ts";

for (const phone of [false, true]) {
  test(`joined ${phone ? "phone" : "desktop"} owns its device and lists every machine`, async ({ browser, baseURL }, info) => {
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
          request.onupgradeneeded = () => request.result.createObjectStore("device");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction("device", "readwrite");
          const store = transaction.objectStore("device");
          store.put({ kind: "raw", privateKey: new Uint8Array(fixture.cardSecret) }, "card-key");
          store.put({ kind: "raw", privateKey: new Uint8Array(fixture.deviceSecret) }, "device-key");
          store.put(fixture.mesh, "mesh.current");
          store.put(fixture.records, `mesh.bundle.${fixture.mesh}`);
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(transaction.error);
        });
        db.close();
      }, browserMeshFixture());
      await page.goto("/settings");
      await expect(page.getByText("my-browser", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Host", exact: true })).toHaveCount(0);
      await expect(page.getByText("This machine", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Leave this mesh", exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`this-device-${phone ? "phone" : "desktop"}.png`), fullPage: true });
      await page.getByRole("tab", { name: "Machines", exact: true })
        .or(page.getByRole("button", { name: "Machines", exact: true })).first().click();
      await expect(page.getByRole("list", { name: "Machines", exact: true })).toContainText("studio");
      await expect(page.getByRole("list", { name: "Machines", exact: true })).toContainText("workshop");
      await expect(page.getByText("my-browser (this browser)", { exact: true })).toBeVisible();
      await expect(page.getByText("This machine", { exact: true })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`machines-${phone ? "phone" : "desktop"}.png`), fullPage: true });
    } finally { await context.close(); }
  });
}
