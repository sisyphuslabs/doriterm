// Web push for the e2e specs: a loopback push service the host posts to, a browser whose PushManager subscribes
// to it, and the worker's push and notification-click events driven as the browser would drive them.
import { decryptPushBody, type ReceiverKeys, receiverKeys, verifyVapid } from "@doriface/host/testing/push-receiver";
import { type BrowserContext, expect, type Page, type Worker } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { E2E_HOST_PORT, E2E_TOKEN, E2E_WEB_PORT } from "./config.ts";

export interface Posted {
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Uint8Array;
  /** The notice as the subscribed browser decrypts it. */
  readonly notice: Readonly<Record<string, unknown>>;
  /** The VAPID key the host signed with. */
  readonly vapidKey: string;
}

/** Answers every POST with 201 and keeps what arrived; `next` resolves with the next notice, in order. */
export class TestPushService {
  readonly posted: Posted[] = [];
  readonly keys: ReceiverKeys;
  readonly #server: Server;
  readonly #waiting: ((posted: Posted) => void)[] = [];
  #seen = 0;

  private constructor(keys: ReceiverKeys) {
    this.keys = keys;
    this.#server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(201).end();
        void this.#arrive(request.url ?? "", request.headers, new Uint8Array(Buffer.concat(chunks)));
      });
    });
  }

  static async start(): Promise<TestPushService> {
    const service = new TestPushService(await receiverKeys());
    // Port 0: the system picks a free port, so parallel workers never collide; the hosts allow any loopback port.
    await new Promise<void>((resolve) => service.#server.listen(0, "127.0.0.1", resolve));
    return service;
  }

  get endpoint(): string {
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("the test push service is not listening");
    return `http://127.0.0.1:${address.port}/push/e2e-device`;
  }

  /** The next notice not yet taken. */
  next(): Promise<Posted> {
    const ready = this.posted[this.#seen];
    if (ready !== undefined) {
      this.#seen += 1;
      return Promise.resolve(ready);
    }
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  async #arrive(path: string, headers: Posted["headers"], body: Uint8Array): Promise<void> {
    const authorization = headers["authorization"];
    const { key } = await verifyVapid(typeof authorization === "string" ? authorization : "");
    const notice: unknown = JSON.parse(new TextDecoder().decode(await decryptPushBody(body, this.keys)));
    if (typeof notice !== "object" || notice === null) throw new Error("a notice that is no object");
    const posted = { path, headers, body, notice: Object.fromEntries(Object.entries(notice)), vapidKey: key };
    this.posted.push(posted);
    const waiting = this.#waiting.shift();
    if (waiting !== undefined) {
      this.#seen += 1;
      waiting(posted);
    }
  }
}

/**
 * Chromium's own PushManager needs a real push service; this one hands the app a subscription at the test service
 * with the test's keys, kept in localStorage so a reload finds it, as the browser keeps a real one.
 */
export async function stubPushManager(page: Page, service: TestPushService): Promise<void> {
  await page.addInitScript(
    ({ endpoint, p256dh, auth }) => {
      const KEY = "e2e.push-subscription";
      const make = (key: readonly number[]) => ({
        endpoint,
        expirationTime: null,
        options: { applicationServerKey: new Uint8Array(key).buffer, userVisibleOnly: true },
        toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }),
        unsubscribe: async () => {
          localStorage.removeItem(KEY);
          return true;
        },
      });
      const saved = (): readonly number[] | null => {
        const text = localStorage.getItem(KEY);
        return text === null ? null : JSON.parse(text);
      };
      Object.assign(PushManager.prototype, {
        async subscribe(options: { applicationServerKey: Uint8Array }) {
          const key = [...new Uint8Array(options.applicationServerKey)];
          localStorage.setItem(KEY, JSON.stringify(key));
          return make(key);
        },
        async getSubscription() {
          const key = saved();
          return key === null ? null : make(key);
        },
      });
    },
    { endpoint: service.endpoint, p256dh: service.keys.p256dh, auth: service.keys.auth },
  );
}

/** The key the app subscribed with, as base64url: the host's VAPID public key. */
export const subscribedKey = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const text = localStorage.getItem("e2e.push-subscription");
    return text === null
      ? null
      : btoa(String.fromCharCode(...JSON.parse(text)))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/, "");
  });

export async function serviceWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? context.waitForEvent("serviceworker");
}

/** Delivers a decrypted push to the app's worker as the browser does after its push service hands it over. */
export async function deliverPush(context: BrowserContext, data: string): Promise<void> {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const origin = `http://127.0.0.1:${E2E_WEB_PORT}`;
  const registration = new Promise<string>((resolve) => {
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
      const found = registrations.find((entry) => entry.scopeURL.startsWith(origin) && !entry.isDeleted);
      if (found !== undefined) resolve(found.registrationId);
    });
  });
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.deliverPushMessage", { origin, registrationId: await registration, data });
  await cdp.detach();
  await page.close();
}

export interface Shown {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly actions: readonly string[];
}

/** The notifications the worker shows now. */
export const shownNotifications = (worker: Worker): Promise<Shown[]> =>
  worker.evaluate(`self.registration.getNotifications().then((list) =>
    list.map((n) => ({ title: n.title, body: n.body, tag: n.tag, actions: (n.actions ?? []).map((a) => a.action) })))`);

/**
 * A tap on a shown notification (`action` "" for the notification itself). DevTools cannot click a system
 * notification, so the worker gets the event a click would fire; `waitUntil` is caught here because a page-made
 * event may not extend its lifetime, and the returned promise settles when the handler's work does.
 */
export async function tapNotification(worker: Worker, tag: string, action: string): Promise<void> {
  // DevTools' deliverPushMessage returns before the worker's showNotification settles: tap only once it is shown. A
  // permission or question notice is shown only after the worker asked the host for its rows (up to sw.ts's 4 s
  // deadline, #669), so the wait allows for that whole exchange on a loaded runner.
  await expect
    .poll(async () => (await shownNotifications(worker)).some((shown) => shown.tag === tag), { timeout: 15_000 })
    .toBe(true);
  await worker.evaluate(`(async () => {
    const [notification] = await self.registration.getNotifications({ tag: ${JSON.stringify(tag)} });
    if (notification === undefined) throw new Error("no notification to tap");
    const event = new NotificationEvent("notificationclick", { notification, action: ${JSON.stringify(action)} });
    let work = Promise.resolve();
    Object.defineProperty(event, "waitUntil", { value: (promise) => { work = promise; } });
    self.dispatchEvent(event);
    await work;
  })()`);
}

/** One line to the e2e host's push stream as the loopback client; resolves with its reply. */
export async function askHost(line: object, port = E2E_HOST_PORT): Promise<Readonly<Record<string, unknown>>> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/push`, ["doriface.v1", `doriface.token.${E2E_TOKEN}`]);
  socket.binaryType = "arraybuffer";
  const reply = new Promise<string>((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(new TextDecoder().decode(new Uint8Array(event.data))));
    socket.addEventListener("error", () => reject(new Error("the push stream did not open")));
  });
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  socket.send(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
  const answer: unknown = JSON.parse(await reply);
  socket.close();
  if (typeof answer !== "object" || answer === null) throw new Error("the host answered no object");
  return Object.fromEntries(Object.entries(answer));
}

/** The subscriptions an e2e host (the main one by default) holds for the loopback client. */
export async function heldSubscriptions(port = E2E_HOST_PORT): Promise<readonly unknown[]> {
  const held = (await askHost({ t: "hello" }, port))["subscriptions"];
  if (!Array.isArray(held)) throw new Error("the host answered no subscriptions");
  return held;
}
