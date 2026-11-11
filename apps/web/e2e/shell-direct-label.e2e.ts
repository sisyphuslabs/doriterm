import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { type FakeRelayHost, startFakeRelayHost } from "./relay-route.ts";

// #1435 item 1: the desktop shell's Direct label in the status bar. A browser always says Relay (#1381 §8); only a page
// with the shell's byte forwarder (`window.doriface`) races a saved Direct address, and its bar says which path won and
// why. The forwarder here is a stub that hands the page the fake host's own direct listener, as the shell hands over its
// forward of the address it holds.
test.use({ serviceWorkers: "block" });

const SETTINGS_KEY = "doriface.connection";
/** The saved Direct address: another machine, so the page cannot dial it itself and asks the forwarder. */
const DIRECT_ADDRESS = "ws://studio.lan:7681/v1/e2ee";

/** Pairs over the relay, then keeps those settings across loads with the Direct address added. */
async function pairWithDirectAddress(page: Page, host: FakeRelayHost): Promise<void> {
  await host.route(page);
  await page.goto(await host.pairingLink());
  await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
  await expect(page.getByRole("status").getByText("Paired")).toBeVisible({ timeout: 30_000 });
  const paired = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
  if (paired === null) throw new Error("pairing saved no connection");
  const parsed: unknown = JSON.parse(paired);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("pairing saved no connection settings");
  const settings: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) settings[key] = Reflect.get(parsed, key);
  settings["directUrl"] = DIRECT_ADDRESS;
  const seeded: readonly [string, string] = [SETTINGS_KEY, JSON.stringify(settings)];
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), seeded);
}

/**
 * The shell's forwarder, stubbed: `forward` is what each forward answers. The targets the page set are kept on the
 * window, so the spec can tell the forwarder was asked for the saved address.
 */
async function withForwarder(page: Page, forward: { readonly url: string } | { readonly refused: string }) {
  await page.addInitScript((answer) => {
    const targets: string[] = [];
    Reflect.set(window, "__directTargets", targets);
    Reflect.set(window, "doriface", {
      setDirectTarget: (target: string) => {
        targets.push(target);
        return Promise.resolve(true);
      },
      forwardDirect: () => Promise.resolve(answer),
      cancelDirectForward: () => Promise.resolve(true),
    });
  }, forward);
  // The direct race's 300 ms is the page's own clock: on a busy machine the socket alone can take longer, and the page
  // rightly takes the relay. Here only the forwarded attempt's answer decides which path the bar names (#780).
  await page.addInitScript(() => Reflect.set(window, "__dorifaceDirectBudgetMs", Number.POSITIVE_INFINITY));
}

const directTargets = (page: Page): Promise<unknown> => page.evaluate(() => Reflect.get(window, "__directTargets"));

test.describe("the desktop shell's connection path label (#1435)", () => {
  let host: FakeRelayHost;
  test.beforeAll(async () => {
    test.setTimeout(60_000);
    host = await startFakeRelayHost({ direct: true });
  });
  test.afterAll(async () => host.stop());

  test("a session the forwarder carries says Direct, with why in its title", async ({ page }) => {
    test.setTimeout(90_000);
    await pairWithDirectAddress(page, host);
    await withForwarder(page, { url: host.directUrl });
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));
    await page.goto("/");
    const path = page.locator("[data-connection-path]");
    await expect(path).toHaveAttribute("data-connection-path", "direct", { timeout: 30_000 });
    await expect(path).toHaveText("Direct");
    await expect(path).toHaveAttribute("title", /^Direct: /);
    await expect(page.getByRole("contentinfo")).toContainText("Direct");
    // The forwarder was asked for the saved address, the session rode its forward, and no relay client socket opened.
    expect(await directTargets(page)).toEqual([DIRECT_ADDRESS]);
    expect(sockets).toContain(host.directUrl);
    expect(sockets.filter((url) => url.includes("/v1/client/"))).toEqual([]);
  });

  test("a forward the shell refuses falls back to the relay, and the title says why", async ({ page }) => {
    test.setTimeout(90_000);
    await pairWithDirectAddress(page, host);
    await withForwarder(page, { refused: "the shell forwards no address here" });
    await page.goto("/");
    const path = page.locator("[data-connection-path]");
    await expect(path).toHaveAttribute("data-connection-path", "relay", { timeout: 30_000 });
    await expect(path).toHaveText("Relay");
    // A reason, not the browser's every-session-is-relay title nor the shell's plain one: the refusal reads as blocked.
    await expect(path).toHaveAttribute("title", /^Relay: this page can't open ws:\/\//);
    expect(await directTargets(page)).toEqual([DIRECT_ADDRESS]);
  });
});
