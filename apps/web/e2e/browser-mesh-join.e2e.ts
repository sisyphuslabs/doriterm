import { phoneContext, routeOnlyRelay, savedMembership } from "./browser-mesh-page.ts";
import { devices, expect, test } from "@playwright/test";
import { startFakeRelayHost } from "./relay-route.ts";

test.use({ serviceWorkers: "block" });

for (const phone of [false, true]) {
  test(`a ${phone ? "phone" : "desktop"} joins with both confirmations and reaches its learned machine over the relay`, async ({
    browser,
    baseURL,
  }, info) => {
    const host = await startFakeRelayHost({ terminal: true, machine: true });
    const context = await browser.newContext({
      ...(phone ? devices["iPhone 14"] : { viewport: { width: 1440, height: 900 } }),
      ...(baseURL === undefined ? {} : { baseURL }),
      serviceWorkers: "block",
    });
    // A storage permission prompt may remain open while both people compare the join code.
    await context.addInitScript(() => {
      let requests = 0;
      Reflect.set(globalThis, "__meshPersistRequests", requests);
      const storage = navigator.storage;
      Object.defineProperty(navigator, "storage", { value: storage });
      Object.defineProperty(storage, "persist", {
        value: () => {
          Reflect.set(globalThis, "__meshPersistRequests", ++requests);
          return new Promise<boolean>(() => undefined);
        },
      });
    });
    try {
      const page = await context.newPage();
      await routeOnlyRelay(page, host);
      await page.goto("/pair");
      await expect(page.getByRole("heading", { name: "Join a mesh", exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath("invite-entry.png"), fullPage: true });
      const offer = await host.meshOffer();
      await page.goto(offer.link);
      await expect(page.getByRole("heading", { name: "Join this mesh" })).toBeVisible();
      await page.getByLabel("This browser's name").fill(phone ? "phone-browser" : "desktop-browser");
      await page.getByRole("button", { name: "Join", exact: true }).click();
      await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, "__meshPersistRequests"))).toBe(1);
      await expect(page.getByLabel("Join code")).toBeVisible();
      const pending = await host.pendingJoin();
      await expect(page.getByLabel("Join code")).toHaveText(pending.code);
      expect(await savedMembership(page)).toBeNull();
      await page.screenshot({ path: info.outputPath("compare-code.png"), fullPage: true });
      await page.getByRole("button", { name: "The codes match", exact: true }).click();
      await expect(page.getByRole("heading", { name: /Waiting for approval/ })).toBeVisible();
      expect(await savedMembership(page)).toBeNull();
      await host.answerJoin(pending.nonce, pending.code, true);
      await expect(page).toHaveURL(/\/settings#machines$/);
      await expect(page.getByRole("list", { name: "Machines", exact: true })).toContainText("studio");
      await expect(page.getByRole("list", { name: "Machines", exact: true })).toContainText("Online");
      await expect(page.getByText("This machine", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Last session on studio: just now", { exact: true })).toBeVisible({
        timeout: 25_000,
      });
      await page.screenshot({ path: info.outputPath("joined-machines.png"), fullPage: true });
      await page.goto("/");
      await expect(page.getByText("existing", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText("this machine", { exact: true })).toHaveCount(0);
      await page.reload();
      await expect(page.getByText("existing", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText("this machine", { exact: true })).toHaveCount(0);
    } finally {
      await context.close();
      await host.stop();
    }
  });
}

test("rejecting the code comparison leaves no membership or join anchor", async ({ page }) => {
  const host = await startFakeRelayHost();
  try {
    await routeOnlyRelay(page, host);
    await page.goto((await host.meshOffer()).link);
    await page.getByRole("button", { name: "Join", exact: true }).click();
    await expect(page.getByLabel("Join code")).toBeVisible();
    await page.getByRole("button", { name: "The codes differ" }).click();
    await expect(page.getByText("Not joined", { exact: true })).toBeVisible();
    expect(await savedMembership(page)).toBeNull();
    const anchor = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open("doriface", 1);
        request.addEventListener("success", () => resolve(request.result));
      });
      try {
        return await new Promise<unknown>((resolve) => {
          const request = db.transaction("device").objectStore("device").get("mesh.join-anchor");
          request.addEventListener("success", () => resolve(request.result ?? null));
        });
      } finally {
        db.close();
      }
    });
    expect(anchor).toBeNull();
  } finally {
    await host.stop();
  }
});

test("a home-screen join resumes the same code after its page closes for approval", async ({ browser, baseURL }) => {
  const host = await startFakeRelayHost({ terminal: true });
  const app = await phoneContext(browser, baseURL, "app");
  try {
    const first = await app.newPage();
    await routeOnlyRelay(first, host);
    await first.goto((await host.meshOffer()).link);
    await first.getByRole("button", { name: "Join", exact: true }).click();
    await expect(first.getByLabel("Join code")).toBeVisible();
    const pending = await host.pendingJoin();
    await expect(first.getByLabel("Join code")).toHaveText(pending.code);
    await first.close();
    await host.answerJoin(pending.nonce, pending.code, true);
    const resumed = await app.newPage();
    await routeOnlyRelay(resumed, host);
    await resumed.goto("/join");
    await expect(resumed.getByLabel("Join code")).toHaveText(pending.code);
    await resumed.getByRole("button", { name: "The codes match", exact: true }).click();
    await expect(resumed).toHaveURL(/\/settings#machines$/);
    await expect(resumed.getByRole("list", { name: "Machines", exact: true })).toContainText("Online");
  } finally {
    await app.close();
    await host.stop();
  }
});

test.describe("a desktop browser whose machine stops", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the Machines row reads Reconnecting while the status bar does, not Online (#2421)", async ({ page }) => {
    const host = await startFakeRelayHost({ terminal: true, machine: true });
    try {
      await routeOnlyRelay(page, host);
      await page.goto((await host.meshOffer()).link);
      await page.getByRole("button", { name: "Join", exact: true }).click();
      const pending = await host.pendingJoin();
      await expect(page.getByLabel("Join code")).toHaveText(pending.code);
      await page.getByRole("button", { name: "The codes match", exact: true }).click();
      await host.answerJoin(pending.nonce, pending.code, true);
      await expect(page).toHaveURL(/\/settings#machines$/);
      const machines = page.getByRole("list", { name: "Machines", exact: true });
      await expect(machines).toContainText("Online · Relay", { timeout: 20_000 });

      await host.stop();
      // At this size Settings is a dialog over the workspace: the status bar under it is still drawn, but hidden from
      // the accessibility tree while the dialog is open, so it is found by the workspace's mark instead of by role.
      const bar = page.locator('[data-workspace] [role="status"]').filter({ hasText: "Reconnecting…" });
      await expect(bar).toBeVisible({ timeout: 15_000 });
      await expect(machines).toContainText("Reconnecting · Relay");
      await expect(machines).not.toContainText("Online");
    } finally {
      await host.stop();
    }
  });
});
