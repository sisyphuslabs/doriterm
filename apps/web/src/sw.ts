/// <reference lib="webworker" />
import { base64urlDecode } from "@doriface/crypto";
import {
  DEFAULT_PUSH_PREFS,
  type NoticePrompt,
  parsePushNotice,
  type PushClientLine,
  type PushHostLine,
  type PushNotice,
} from "@doriface/protocol";
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { ICON_FONT_CACHE, isIconFont, keepsIconFont, pruneIconFonts, splitIconFonts } from "./pwa/icon-font-cache.ts";
import { planClick } from "./push/notice-click.ts";
import { DEFAULT_MAX_ACTIONS, noticeDisplay } from "./push/notice-display.ts";
import { deadlineAfter, exchangeWithin, type PushExchange } from "./push/over-push.ts";
import { loadPushPrefs, loadPushRoute, openPushLink } from "./push/push-route.ts";
import { carryOver } from "./push/reconcile.ts";
import { asSubscription } from "./push/subscription-keys.ts";
import { PushStreamClient } from "./push/push-stream-client.ts";

declare const self: ServiceWorkerGlobalScope & {
  readonly __WB_MANIFEST: (string | { readonly url: string; readonly revision: string | null })[];
};

// Precache the build and serve index.html for navigations. A first worker takes over at once; a newer one waits until
// the page sends SKIP_WAITING (Reload to update in Settings, through vite-plugin-pwa's updateSW).
// The icon font is listed too, and taken out here: it is fetched when first drawn, and its name says which to keep.
// oxlint-disable-next-line no-underscore-dangle -- injectManifest replaces this exact name with the precache list
const { precache, iconFonts } = splitIconFonts(self.__WB_MANIFEST, self.location.href);
precacheAndRoute(precache);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")));

registerRoute(
  ({ url }) => url.origin === self.location.origin && isIconFont(url),
  async ({ request, url }) => {
    const cache = await caches.open(ICON_FONT_CACHE);
    const kept = await cache.match(request);
    if (kept !== undefined) return kept;
    const fetched = await fetch(request);
    // A page left open on an earlier build may still ask for its font: that answer comes from the network, and only a
    // name this build's precache list carries is kept (#1166).
    if (fetched.ok && keepsIconFont(url, iconFonts)) await cache.put(request, fetched.clone());
    return fetched;
  },
);
clientsClaim();
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(ICON_FONT_CACHE);
      // A build whose precache list names no icon font keeps the copies that are there; say it once per activation.
      if ((await pruneIconFonts(cache, iconFonts)) === null)
        console.warn("this build's precache list names no icon font: the kept copy is not pruned");
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data: unknown = event.data;
  if (typeof data === "object" && data !== null && Reflect.get(data, "type") === "SKIP_WAITING")
    void self.skipWaiting();
});

/** How long an Allow or Deny waits for the host before it opens the pane instead. */
const ANSWER_TIMEOUT_MS = 15_000;
/** How long a push waits for the host to name its prompt's rows before it shows the notice without them. */
const PROMPT_TIMEOUT_MS = 4_000;

function readPayload(event: PushEvent): unknown {
  try {
    return event.data?.json();
  } catch {
    return undefined;
  }
}

self.addEventListener("push", (event) => {
  const notice = parsePushNotice(readPayload(event));
  // Every push shows a notification: a browser that sees pushes without one revokes or replaces the subscription.
  if (notice === undefined) {
    event.waitUntil(self.registration.showNotification("Doriterm", { body: "Open Doriterm to see what changed." }));
    return;
  }
  event.waitUntil(showNotice(notice));
});

/**
 * A permission or a question asks the host over the E2EE push stream which rows its prompt has, so the notification
 * can offer them; the payload itself names nothing. A host that does not answer in time, or names none, gets the
 * notice without rows (a permission keeps Allow and Deny).
 */
async function showNotice(notice: PushNotice): Promise<void> {
  const prompt =
    notice.k === "permission" || notice.k === "input" ? await promptOf(notice).catch(() => undefined) : undefined;
  // `Notification.maxActions` is not in TypeScript's DOM types; Chromium reports it.
  const max: unknown = Reflect.get(Notification, "maxActions");
  const { title, ...shown } = noticeDisplay(
    notice,
    prompt,
    typeof max === "number" && max > 0 ? max : DEFAULT_MAX_ACTIONS,
  );
  // TypeScript's NotificationOptions lacks `actions`, which Chromium and Firefox show.
  const options: NotificationOptions & Pick<typeof shown, "actions"> = { ...shown, icon: "/icon-192.png" };
  await self.registration.showNotification(title, options);
}

async function promptOf(notice: PushNotice): Promise<NoticePrompt | undefined> {
  const reply = await overPush({ t: "notice", id: notice.n }, PROMPT_TIMEOUT_MS);
  return reply.t === "notice" ? reply.prompt : undefined;
}

async function openSession(): Promise<PushExchange> {
  const route = await loadPushRoute();
  if (route === undefined) throw new Error("notifications are off on this device");
  return new PushStreamClient(await openPushLink(route));
}

/**
 * One line over a fresh E2EE push session, all of it (route, link and reply) inside the deadline. An answer: the host
 * checks the live prompt first and types only if it is unchanged.
 */
async function overPush(line: PushClientLine, timeoutMs = ANSWER_TIMEOUT_MS): Promise<PushHostLine> {
  const deadline = deadlineAfter(timeoutMs);
  try {
    return await exchangeWithin(openSession, line, deadline.expired);
  } finally {
    deadline.cancel();
  }
}

/**
 * The browser replaced or dropped this device's subscription (expiry, rotation): the host drops the old endpoint and
 * takes the new one with the same preferences, so notices keep coming without opening Settings.
 */
async function carryOverHere(old: unknown, fresh: unknown): Promise<void> {
  const route = await loadPushRoute();
  if (route === undefined) return;
  const client = new PushStreamClient(await openPushLink(route));
  try {
    const ready = await client.request({ t: "hello" });
    if (ready.t !== "ready") return;
    const next =
      asSubscription(fresh) ??
      asSubscription(
        await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: new Uint8Array(base64urlDecode(ready.vapidKey)),
        }),
      );
    if (next === null) return;
    const prefs = (await loadPushPrefs()) ?? DEFAULT_PUSH_PREFS;
    await carryOver(asSubscription(old), next, prefs, (line) => client.request(line));
  } finally {
    client.close();
  }
}

self.addEventListener("pushsubscriptionchange", (event: Event) => {
  if (!(event instanceof ExtendableEvent)) return;
  event.waitUntil(carryOverHere(Reflect.get(event, "oldSubscription"), Reflect.get(event, "newSubscription")));
});

/** Focuses an open window and hands it the notice, or opens one at the notice's address. */
async function openApp(url: string): Promise<void> {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const open = windows[0];
  if (open === undefined) {
    await self.clients.openWindow(url);
    return;
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's Client.postMessage takes no origin
  open.postMessage({ type: "doriface-notice", url });
  // Posted first: the window opens the pane even where the browser refuses to bring it to the front.
  await open.focus().catch(() => undefined);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    planClick(event.action, event.notification.data, (line) => overPush(line)).then((plan) =>
      plan.open === null ? undefined : openApp(plan.open),
    ),
  );
});
