import type { ByteLink } from "@doriface/client";
import { base64urlDecode, secureLink } from "@doriface/crypto";
import { connectRelayClient } from "@doriface/relay-client";
import { loadDeviceKey } from "../connection/device-key.ts";
import { directDial, pageAccess, parseDirectAddress } from "../connection/direct-address.ts";
import { attemptDirect } from "../connection/direct-attempt.ts";
import type { ConnectionSettings } from "../connection/settings.ts";
import { loopbackOnly } from "../connection/loopback-address.ts";
import { openWebSocketLink } from "../connection/ws-link.ts";
import { deviceStore, type KeyValueStore } from "../storage/idb.ts";
import { parsePushClientLine, type PushPrefs } from "@doriface/protocol";

/**
 * How to reach the host's push stream. The service worker cannot read localStorage, where the connection settings
 * live, so turning notifications on copies this much of them into the IndexedDB store that holds the device key.
 * A relay route keeps the direct address too: push follows the same direct-first rule as the page (#446 §3).
 */
export type PushRoute =
  | {
      readonly mode: "relay";
      readonly relayUrl: string;
      readonly hostId: string;
      readonly hostKey: string;
      readonly directUrl?: string | undefined;
    }
  | { readonly mode: "loopback"; readonly pushUrl: string; readonly token: string };

const KEY = "push-route";

/** The loopback client's push stream sits beside its hc stream: `/v1/hc` -> `/v1/push`. */
export function routeOf(settings: ConnectionSettings): PushRoute {
  if (settings.mode === "relay") {
    return {
      mode: "relay",
      relayUrl: settings.relayUrl,
      hostId: settings.hostId,
      hostKey: settings.hostKey,
      directUrl: settings.directUrl,
    };
  }
  const url = new URL(settings.loopbackUrl);
  url.pathname = url.pathname.replace(/\/v1\/hc$/, "/v1/push");
  return { mode: "loopback", pushUrl: url.href, token: settings.token };
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

function parseRoute(value: unknown): PushRoute | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const get = (key: string): unknown => Reflect.get(value, key);
  const [relayUrl, hostId, hostKey, pushUrl, token, directUrl] = [
    "relayUrl",
    "hostId",
    "hostKey",
    "pushUrl",
    "token",
    "directUrl",
  ].map(get);
  if (get("mode") === "relay" && isText(relayUrl) && isText(hostId) && isText(hostKey)) {
    return { mode: "relay", relayUrl, hostId, hostKey, ...(typeof directUrl === "string" ? { directUrl } : {}) };
  }
  if (get("mode") === "loopback" && isText(pushUrl) && isText(token)) return { mode: "loopback", pushUrl, token };
  return undefined;
}

export async function loadPushRoute(store: KeyValueStore = deviceStore): Promise<PushRoute | undefined> {
  return parseRoute(await store.get(KEY));
}

export const savePushRoute = (route: PushRoute | null, store: KeyValueStore = deviceStore): Promise<void> =>
  store.put(KEY, route);

const PREFS_KEY = "push-prefs";

/** The preferences last sent to the host, so the worker can carry them to a replaced subscription. */
export async function loadPushPrefs(store: KeyValueStore = deviceStore): Promise<PushPrefs | undefined> {
  const value = await store.get(PREFS_KEY);
  if (value === undefined || value === null) return undefined;
  try {
    const line = parsePushClientLine(JSON.stringify({ t: "prefs", endpoint: "https://prefs.invalid/", prefs: value }));
    return line.t === "prefs" ? line.prefs : undefined;
  } catch {
    return undefined;
  }
}

export const savePushPrefs = (prefs: PushPrefs, store: KeyValueStore = deviceStore): Promise<void> =>
  store.put(PREFS_KEY, prefs);

export const sameRoute = (a: PushRoute, b: PushRoute): boolean => JSON.stringify(a) === JSON.stringify(b);

const SUBPROTOCOL = "doriface.v1";
const TOKEN_PREFIX = "doriface.token.";

export interface PushLinkOptions {
  readonly budgetMs?: number | undefined;
}

/**
 * Opens the push stream: the same E2EE session (`stream:"push"`) the main connection uses, so it runs the same
 * direct-first race and only falls back to the relay when the direct address does not answer (#446 §3).
 */
export async function openPushLink(route: PushRoute, options: PushLinkOptions = {}): Promise<ByteLink> {
  if (route.mode === "loopback") {
    return openWebSocketLink(loopbackOnly(route.pushUrl, "push"), [SUBPROTOCOL, TOKEN_PREFIX + route.token]);
  }
  const direct = await openDirectPush(route, options);
  if (direct !== undefined) return direct;
  // One socket: a push session carries a request or two and closes, so a second and third socket would only add a Room
  // round trip to every notice and answer (#1418).
  const link = await connectRelayClient({ relayUrl: route.relayUrl, hostId: route.hostId, bestOf: 1 });
  try {
    return await secureLink(link, {
      role: "initiator",
      hostId: route.hostId,
      staticKey: await loadDeviceKey(),
      remoteStatic: base64urlDecode(route.hostKey),
      stream: "push",
    });
  } catch (error) {
    link.close();
    throw error;
  }
}

/** The direct push session, or undefined when the address is unset, unusable, blocked, or does not answer in budget. */
async function openDirectPush(
  route: Extract<PushRoute, { readonly mode: "relay" }>,
  options: PushLinkOptions,
): Promise<ByteLink | undefined> {
  const address = parseDirectAddress(route.directUrl ?? "");
  if (!address.usable) return undefined;
  const dial = directDial(address, pageAccess());
  if (dial.kind !== "dial") return undefined;
  try {
    return await attemptDirect({
      url: dial.url,
      ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
      secure: async (link) =>
        await secureLink(link, {
          role: "initiator",
          hostId: route.hostId,
          staticKey: await loadDeviceKey(),
          remoteStatic: base64urlDecode(route.hostKey),
          stream: "push",
        }),
    });
  } catch {
    return undefined;
  }
}
