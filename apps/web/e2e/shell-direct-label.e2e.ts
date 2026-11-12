import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { type FakeRelayHost, startFakeRelayHost } from "./relay-route.ts";

// #1435 item 1: the desktop shell's connection path label in the status bar. A browser always says Relay (#1381 §8). The
// direct path is off (#2070), so the shell says Relay too, even with a saved Direct address and a forwarder that could
// carry it. The forwarder here is a stub that would hand the page the fake host's own direct listener, were it asked.
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
 * The shell's forwarder, stubbed: `forward` is what each forward answers. The targets the page sets are kept on the
 * window, so the spec can tell whether the forwarder was ever handed an address.
 */
async function withForwarder(page: Page, forward: { readonly url: string }) {
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
  // rightly takes the relay. An unbounded budget means a direct attempt, if one ever ran, would surely show (#780).
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

  test("with the direct path off, a shell whose forwarder could carry the saved address says Relay and is never handed it (#2070)", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await pairWithDirectAddress(page, host);
    // A forwarder that would carry the session to the host's own direct listener, were it asked to.
    await withForwarder(page, { url: host.directUrl });
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));
    await page.goto("/");
    const path = page.locator("[data-connection-path]");
    await expect(path).toHaveAttribute("data-connection-path", "relay", { timeout: 30_000 });
    await expect(path).toHaveText("Relay");
    await expect(path).toHaveAttribute("title", "Relay: every session goes through the relay.");
    // The saved address never left the page: the forwarder was handed no address, and no socket went to the
    // direct listener. That the relay carried it the label already says: it shows only for a session open over the relay.
    // (The relay's /v1/client/ sockets are served by page.routeWebSocket, which emits no page "websocket" event, so they
    // cannot be counted here.)
    const targets = await directTargets(page);
    // Never handed an address: nothing dials it (connect.ts gates openForwardedLink, the only setTarget with one), so the
    // stub records no target, or only main.tsx's "" where the full desktop bridge is present.
    expect(Array.isArray(targets)).toBe(true);
    expect((Array.isArray(targets) ? targets : []).filter((target) => target !== "")).toEqual([]);
    expect(sockets).not.toContain(host.directUrl);
  });
});
