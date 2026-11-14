import type { ByteLink } from "@doriface/client";
import { base64urlDecode, secureLink } from "@doriface/crypto";
import { connectRelayClient } from "@doriface/relay-client";
import { directDial, pageAccess, parseDirectAddress } from "../connection/direct-address.ts";
import { attemptDirect } from "../connection/direct-attempt.ts";
import { canForwardPlainWs } from "../connection/direct-forward.ts";
import { DIRECT_PATH_ENABLED, directPathAvailable } from "../connection/direct-switch.ts";
import { BROWSER_DEPS, type RelayDeps } from "../connection/relay-deps.ts";
import type { ConnectionSettings } from "../connection/settings.ts";
import { loopbackOnly } from "../connection/loopback-address.ts";
import { openWebSocketLink } from "../connection/ws-link.ts";
import { deviceStore, type KeyValueStore } from "../storage/idb.ts";
import { parsePushClientLine, type PushPrefs } from "@doriface/protocol";

/**
 * How to reach the host's push stream. The service worker cannot read localStorage, where the connection settings
 * live, so turning notifications on copies this much of them into the IndexedDB store that holds the device key.
 * A relay route carries the direct address only in the desktop shell with the direct path switched on (#2070): a
 * browser's push is the relay's (#1381 §8).
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
export function routeOf(settings: ConnectionSettings, directPath: boolean = directPathAvailable()): PushRoute {
  if (settings.mode === "relay") {
    return {
      mode: "relay",
      relayUrl: settings.relayUrl,
      hostId: settings.hostId,
      hostKey: settings.hostKey,
      ...(directPath ? { directUrl: settings.directUrl } : {}),
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

/** The route with no direct address: a page with no direct path never dials one, so its stored route never names one. */
const relayOnly = (route: PushRoute): PushRoute =>
  route.mode === "relay" && route.directUrl !== undefined
    ? { mode: "relay", relayUrl: route.relayUrl, hostId: route.hostId, hostKey: route.hostKey }
    : route;

export const savePushRoute = (
  route: PushRoute | null,
  store: KeyValueStore = deviceStore,
  directPath: boolean = directPathAvailable(),
): Promise<void> => store.put(KEY, route === null || directPath ? route : relayOnly(route));

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
  /** For tests: where the device key comes from; the browser's stored key otherwise (as `connect` takes it). */
  readonly deps?: RelayDeps | undefined;
  /** Runs the direct race though the switch is off (`DIRECT_PATH_ENABLED`): for tests of the mechanism only. */
  readonly directPath?: boolean | undefined;
}

/**
 * Opens the push stream: the same E2EE session (`stream:"push"`) the main connection uses. The relay carries it
 * (#2070); with the direct path switched on, the desktop shell runs the same direct-first race as the page (#446 §3).
 * A browser goes straight to the relay either way (#1381 §8), and so does a service worker, which has no shell bridge.
 */
export async function openPushLink(route: PushRoute, options: PushLinkOptions = {}): Promise<ByteLink> {
  if (route.mode === "loopback") {
    return openWebSocketLink(loopbackOnly(route.pushUrl, "push"), [SUBPROTOCOL, TOKEN_PREFIX + route.token]);
  }
  const deps = options.deps ?? BROWSER_DEPS;
  const direct = await openDirectPush(route, options, deps);
  if (direct !== undefined) return direct;
  // One socket: a push session carries a request or two and closes, so a second and third socket would only add a Room
  // round trip to every notice and answer (#1418).
  const link = await connectRelayClient({ relayUrl: route.relayUrl, hostId: route.hostId, bestOf: 1 });
  try {
    return await secureLink(link, {
      role: "initiator",
      hostId: route.hostId,
      staticKey: await deps.loadDeviceKey(),
      remoteStatic: base64urlDecode(route.hostKey),
      stream: "push",
    });
  } catch (error) {
    link.close();
    throw error;
  }
}

/**
 * The direct push session, or undefined when this is not the desktop shell, the address is unset, unusable, blocked, or
 * does not answer in budget.
 */
async function openDirectPush(
  route: Extract<PushRoute, { readonly mode: "relay" }>,
  options: PushLinkOptions,
  deps: RelayDeps,
): Promise<ByteLink | undefined> {
  // #2070: the direct path is off, so the push stream is the relay's. #1381 §8: a browser's push goes over the relay
  // too, and a service worker has no forwarder; only the desktop shell may dial the address its settings hold.
  // The test-only override decides the switch here as it does in connect(): either way, only the forwarder may dial.
  if (!((options.directPath ?? DIRECT_PATH_ENABLED) && canForwardPlainWs())) return undefined;
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
          staticKey: await deps.loadDeviceKey(),
          remoteStatic: base64urlDecode(route.hostKey),
          stream: "push",
        }),
    });
  } catch {
    return undefined;
  }
}
