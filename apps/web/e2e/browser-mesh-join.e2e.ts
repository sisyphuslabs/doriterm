import { devices, expect, test, type Page } from "@playwright/test";
import { FAKE_RELAY } from "./capture-relay.ts";
import { startFakeRelayHost, type FakeRelayHost } from "./relay-route.ts";

test.use({ serviceWorkers: "block" });

async function routeOnlyRelay(page: Page, host: FakeRelayHost): Promise<void> {
  await page.routeWebSocket(/.*/, (socket) => {
    if (!socket.url().startsWith(`${FAKE_RELAY}/`)) socket.close({ code: 4404, reason: "relay only" });
    else throw new Error("the relay route did not intercept its socket");
  });
  await host.route(page);
}

async function savedMembership(page: Page): Promise<unknown> {
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

for (const phone of [false, true]) {
  test(`a ${phone ? "phone" : "desktop"} joins with both confirmations and reaches its learned machine over the relay`, async ({
    browser,
    baseURL,
  }, info) => {
    const host = await startFakeRelayHost({ terminal: true });
    const context = await browser.newContext({
      ...(phone ? devices["iPhone 14"] : { viewport: { width: 1440, height: 900 } }),
      ...(baseURL === undefined ? {} : { baseURL }),
      serviceWorkers: "block",
    });
    try {
      const page = await context.newPage();
      await routeOnlyRelay(page, host);
      const offer = await host.meshOffer();
      await page.goto(offer.link);
      await expect(page.getByRole("heading", { name: "Join this mesh" })).toBeVisible();
      await page.getByLabel("This browser's name").fill(phone ? "phone-browser" : "desktop-browser");
      await page.getByRole("button", { name: "Join", exact: true }).click();
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
      await page.reload();
      await expect(page.getByText("existing", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    } finally {
      await context.close();
      await host.stop();
    }
  });
}

test("a substituted invite rejected by the person leaves no membership or join anchor", async ({ page }) => {
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
  const app = await browser.newContext({
    ...devices["iPhone 14"],
    ...(baseURL === undefined ? {} : { baseURL }),
    serviceWorkers: "block",
  });
  await app.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { value: true });
  });
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

test("Safari hands an invite to an empty app partition, compares both screens, then removes only its tab", async ({
  browser,
  baseURL,
}, info) => {
  const host = await startFakeRelayHost({ terminal: true });
  const options = {
    ...devices["iPhone 14"],
    ...(baseURL === undefined ? {} : { baseURL }),
    serviceWorkers: "block" as const,
  };
  const safari = await browser.newContext({ ...options, permissions: ["clipboard-read", "clipboard-write"] });
  const app = await browser.newContext(options);
  await app.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
  try {
    const tab = await safari.newPage();
    await routeOnlyRelay(tab, host);
    await tab.goto((await host.meshOffer()).link);
    await tab.getByLabel("This browser's name").fill("safari-tab");
    await tab.getByRole("button", { name: "Join", exact: true }).click();
    await expect(tab.getByLabel("Join code")).toBeVisible();
    const first = await host.pendingJoin();
    await expect(tab.getByLabel("Join code")).toHaveText(first.code);
    await tab.getByRole("button", { name: "The codes match", exact: true }).click();
    await host.answerJoin(first.nonce, first.code, true);
    await expect(tab).toHaveURL(/\/settings#machines$/);
    await tab.goto("/settings");
    await tab.getByRole("button", { name: "Join in the home-screen app", exact: true }).click();
    await expect(tab.getByRole("link", { name: "Open invite", exact: true })).toBeVisible();
    await tab.getByRole("button", { name: "Copy invite", exact: true }).click();
    const invite = await tab.evaluate(() => navigator.clipboard.readText());
    expect(invite).toContain("/pair#");
    await tab.screenshot({ path: info.outputPath("safari-handoff.png"), fullPage: true });
    const installed = await app.newPage();
    await routeOnlyRelay(installed, host);
    await installed.goto("/");
    await expect(installed.getByRole("button", { name: "Paste invite", exact: true })).toBeVisible();
    expect(await savedMembership(installed)).toBeNull();
    await installed.getByLabel("Invite link or code").fill(invite);
    await installed.getByRole("button", { name: "Continue", exact: true }).click();
    await installed.getByLabel("This browser's name").fill("safari-app");
    await installed.getByRole("button", { name: "Join", exact: true }).click();
    await expect(installed.getByLabel("Join code")).toBeVisible();
    const code = await installed.getByLabel("Join code").textContent();
    if (code === null) throw new Error("the joining app did not show its code");
    // The host publishes status every 10 s; the reader can be one more 10 s tick behind it.
    await expect(tab.getByLabel("Join code")).toHaveText(code, { timeout: 25_000 });
    await tab.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(tab.getByText("Waiting for safari-app to confirm the code", { exact: true })).toBeVisible();
    expect(await savedMembership(installed)).toBeNull();
    await installed.getByRole("button", { name: "The codes match", exact: true }).click();
    await expect(installed).toHaveURL(/\/settings#machines$/);
    await expect(
      tab.getByText("The home-screen app joined. Remove this tab from the mesh?", { exact: true }),
    ).toBeVisible();
    await expect(tab.getByLabel("Join code")).toHaveCount(0);
    await expect(tab.getByRole("button", { name: "Keep", exact: true })).toBeVisible();
    await tab.screenshot({ path: info.outputPath("safari-cleanup.png"), fullPage: true });
    await tab.getByRole("button", { name: "Remove", exact: true }).click();
    await tab.getByRole("button", { name: "Leave this mesh", exact: true }).click();
    await expect(tab).toHaveURL(/\/join$/);
    expect(await savedMembership(tab)).toBeNull();
    expect(await savedMembership(installed)).not.toBeNull();
    await installed.reload();
    await expect(installed.getByRole("list", { name: "Machines", exact: true })).toContainText("Online");
    await installed.getByRole("button", { name: "Open", exact: true }).click();
    await expect(installed.getByText("existing", { exact: true }).first()).toBeVisible();
  } finally {
    await safari.close();
    await app.close();
    await host.stop();
  }
});
