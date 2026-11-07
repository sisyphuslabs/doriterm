// Notifications that were turned on stay registered: a dropped or lost subscription is made again, a replaced one is
// carried over by the worker, and a connection moved to another host takes them along.
import type { Page } from "@playwright/test";
import { E2E_HOST_PORT, E2E_LAYOUT_PORT } from "./config.ts";
import { expect, test } from "./fixtures.ts";
import { askHost, heldSubscriptions, serviceWorker, subscribedKey } from "./push.ts";
import { openSettings, pushState, pushSuite, settingsSection, turnOn } from "./push-suite.ts";

const suite = pushSuite();

const endpoints = async (port = E2E_HOST_PORT): Promise<string[]> =>
  (await heldSubscriptions(port)).map((held) =>
    typeof held === "object" && held !== null ? String(Reflect.get(held, "endpoint")) : "",
  );

/** The route the worker reads, as the app saved it in IndexedDB. */
const savedRoute = (page: Page): Promise<unknown> =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("doriface", 1);
        open.addEventListener("error", () => reject(open.error));
        open.addEventListener("success", () => {
          const get = open.result.transaction("device").objectStore("device").get("push-route");
          get.addEventListener("success", () => resolve(get.result ?? null));
          get.addEventListener("error", () => reject(get.error));
        });
      }),
  );

test("a subscription the browser dropped is made again on load, and one the host lost is sent again", async ({
  page,
}) => {
  const service = suite.service();
  await turnOn(page);
  await page.evaluate(() => localStorage.removeItem("e2e.push-subscription"));
  await askHost({ t: "unsubscribe", endpoint: service.endpoint });
  await openSettings(page);
  await expect(pushState(page)).toHaveAttribute("data-push-state", "on");
  expect(await subscribedKey(page)).not.toBeNull();
  await expect.poll(() => endpoints()).toEqual([service.endpoint]);

  await askHost({ t: "unsubscribe", endpoint: service.endpoint });
  await openSettings(page);
  await expect(pushState(page)).toHaveAttribute("data-push-state", "on");
  await expect.poll(() => endpoints()).toEqual([service.endpoint]);
});

test("a subscription the browser replaced is carried over by the worker", async ({ page, context }) => {
  const service = suite.service();
  await turnOn(page);
  const rotated = `${service.endpoint}-rotated`;
  const worker = await serviceWorker(context);
  await worker.evaluate(`(async () => {
    const as = (endpoint) => ({ endpoint, toJSON: () => ({ endpoint, keys: { p256dh: ${JSON.stringify(service.keys.p256dh)}, auth: ${JSON.stringify(service.keys.auth)} } }) });
    const event = new ExtendableEvent("pushsubscriptionchange");
    let work = Promise.resolve();
    Object.defineProperty(event, "oldSubscription", { value: as(${JSON.stringify(service.endpoint)}) });
    Object.defineProperty(event, "newSubscription", { value: as(${JSON.stringify(rotated)}) });
    Object.defineProperty(event, "waitUntil", { value: (promise) => { work = promise; } });
    self.dispatchEvent(event);
    await work;
  })()`);
  expect(await endpoints()).toEqual([rotated]);
  await askHost({ t: "unsubscribe", endpoint: rotated });
});

test("a connection moved to another host takes notifications along; the old host and the old route drop them", async ({
  page,
}) => {
  const service = suite.service();
  await page.addInitScript(() => Reflect.set(window, "__dorifacePushMoves", []));
  await turnOn(page);
  expect(await savedRoute(page)).toMatchObject({ pushUrl: `ws://127.0.0.1:${E2E_HOST_PORT}/v1/push` });
  await settingsSection(page, "This device").click();
  const gateway = page.getByLabel("Gateway", { exact: true });
  await gateway.fill(`ws://127.0.0.1:${E2E_LAYOUT_PORT}/v1/hc`);
  await gateway.press("Enter");
  // The move this change started is awaited where it runs, and the hosts are read once it is done: a move on a busy
  // machine takes seconds, and polling the hosts on a clock decided the result by the machine's speed (#780).
  const moves = await page.evaluate(async () => {
    const recorded: unknown = Reflect.get(window, "__dorifacePushMoves");
    if (!Array.isArray(recorded)) return 0;
    await Promise.all(recorded);
    return recorded.length;
  });
  expect(moves).toBeGreaterThan(0);
  expect(await endpoints(E2E_LAYOUT_PORT)).toEqual([service.endpoint]);
  expect(await endpoints()).toEqual([]);
  expect(await savedRoute(page)).toMatchObject({ pushUrl: `ws://127.0.0.1:${E2E_LAYOUT_PORT}/v1/push` });
});
