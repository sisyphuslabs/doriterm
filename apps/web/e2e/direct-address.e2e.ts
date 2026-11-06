import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { type FakeRelayHost, startFakeRelayHost } from "./relay-route.ts";

// #446: a saved Direct address is used. The page reaches the host on its network, the relay carries nothing, and an
// address that does not answer falls back to the relay inside the budget.
test.use({ serviceWorkers: "block" });

const SETTINGS_KEY = "doriface.connection";

/** The saved settings, read as the object they are: the pairing handed them over and the Direct address is added. */
function parseSettings(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("pairing saved no connection settings");
  const settings: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) settings[key] = Reflect.get(parsed, key);
  return settings;
}

/** Pairs over the relay, then keeps those settings across loads: the fixture seeds its own on every load. */
async function pairAcrossTheNetwork(page: Page, host: FakeRelayHost): Promise<string> {
  await host.route(page);
  await page.goto(await host.pairingLink());
  await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
  await expect(page.getByRole("status").getByText("Paired")).toBeVisible({ timeout: 30_000 });
  const paired = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
  if (paired === null) throw new Error("pairing saved no connection");
  return paired;
}

async function withDirectAddress(page: Page, paired: string, directUrl: string): Promise<void> {
  const settings = { ...parseSettings(paired), directUrl };
  const seeded: readonly [string, string] = [SETTINGS_KEY, JSON.stringify(settings)];
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), seeded);
}

test.describe("a saved Direct address (#446)", () => {
  let host: FakeRelayHost;
  test.beforeAll(async () => {
    test.setTimeout(60_000);
    host = await startFakeRelayHost({ direct: true });
  });
  test.afterAll(async () => host.stop());

  test("carries the session on the host's own listener, and the page opens no relay socket", async ({ page }) => {
    test.setTimeout(90_000);
    const paired = await pairAcrossTheNetwork(page, host);
    await withDirectAddress(page, paired, host.directUrl);
    // The direct race's 300 ms is the page's own clock: on a busy machine the socket alone can take longer, and the page
    // rightly takes the relay. Here only the direct attempt's answer decides, so this spec is about the path (#780).
    await page.addInitScript(() => Reflect.set(window, "__dorifaceDirectBudgetMs", Number.POSITIVE_INFINITY));
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));
    await page.goto("/");
    await expect(page.locator('[data-connection-path="direct"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("contentinfo")).toContainText("Direct");
    // The direct attempt dialed the host's /v1/e2ee; no client socket went to the relay for this session.
    expect(sockets.filter((url) => url.includes("/v1/e2ee")).length).toBeGreaterThan(0);
    expect(sockets.filter((url) => url.includes("/v1/client/"))).toEqual([]);
  });

  test("an address that does not answer falls back to the relay, and the bar says Relay", async ({ page }) => {
    test.setTimeout(90_000);
    const paired = await pairAcrossTheNetwork(page, host);
    await withDirectAddress(page, paired, "ws://127.0.0.1:1/v1/e2ee");
    await page.goto("/");
    await expect(page.locator('[data-connection-path="relay"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("contentinfo")).toContainText("Relay");
  });
});
