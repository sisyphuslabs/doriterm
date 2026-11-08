import { devices, expect, type Browser, type Page } from "@playwright/test";
import { FAKE_RELAY } from "./capture-relay.ts";
import type { FakeRelayHost } from "./relay-route.ts";

export async function routeOnlyRelay(page: Page, host: FakeRelayHost): Promise<void> {
  await page.routeWebSocket(/.*/, (socket) => {
    if (!socket.url().startsWith(`${FAKE_RELAY}/`)) socket.close({ code: 4404, reason: "relay only" });
    else throw new Error("the relay route did not intercept its socket");
  });
  await host.route(page);
}

export async function savedMembership(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
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
  });
}

export async function phoneContext(browser: Browser, baseURL: string | undefined, mode: "tab" | "app") {
  const context = await browser.newContext({
    ...devices["iPhone 14"],
    ...(baseURL === undefined ? {} : { baseURL }),
    serviceWorkers: "block",
    ...(browser.browserType().name() === "chromium" ? { permissions: ["clipboard-read", "clipboard-write"] } : {}),
  });
  if (mode === "app")
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "standalone", { value: true });
      const match = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        const result = match(query);
        if (query === "(display-mode: standalone)") Object.defineProperty(result, "matches", { value: true });
        return result;
      };
    });
  return context;
}

export async function enterInvite(page: Page, link: string, browserName: string): Promise<void> {
  if (browserName === "chromium") {
    await page.getByRole("button", { name: "Paste invite", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Join this mesh", exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("");
  } else {
    await page.getByLabel("Invite link or code").fill(link);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }
}
