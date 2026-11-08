import { guardedLocalStorage, type StorageLike } from "../storage/guarded.ts";
export type ConnectionMode = "relay" | "loopback";

/** One member this app can reach: a machine it paired with, or joined a mesh through. */
export interface MemberTarget {
  readonly hostId: string;
  /** The name the member answered with last, kept so it can be named while it does not answer (#496). */
  readonly hostName: string;
  /** base64url of the member's Noise static key, which every IK handshake to it needs. */
  readonly hostKey: string;
  /** The member's LAN origin for the direct /v1/e2ee race, when known. */
  readonly directUrl: string;
}

export interface ConnectionSettings {
  /** Derived from a verified bundle, never loaded as a saved pairing. */
  readonly viewMember?: boolean;
  readonly mode: ConnectionMode;
  /** Base URL of the relay; the client path is appended. */
  readonly relayUrl: string;
  /** The host's LAN origin for the direct /v1/e2ee race, when known. */
  readonly directUrl: string;
  /** The paired host to reach over the relay or directly. */
  readonly hostId: string;
  /** The name the host answered with last, kept so it can be named while it does not answer (#496). */
  readonly hostName: string;
  /** base64url of the paired host's Noise static key, which every IK handshake to it needs. */
  readonly hostKey: string;
  /**
   * Every member this app may reach, the selected one included.
   *
   * The four fields above are the one being shown right now; they stay in the file so a reader that predates the roster
   * still finds the address it knows (design of #942, stage 3). One machine dropping is then one row that is offline, not
   * the end of the app.
   */
  readonly members: readonly MemberTarget[];
  /** Loopback dev: the host's plaintext /v1/hc WebSocket URL and its token. */
  readonly loopbackUrl: string;
  readonly token: string;
}

export const DEFAULT_RELAY_URL = "wss://relay-doriface.omo.dev";

export const DEFAULT_SETTINGS: ConnectionSettings = {
  mode: "relay",
  relayUrl: DEFAULT_RELAY_URL,
  directUrl: "",
  hostId: "",
  hostName: "",
  hostKey: "",
  members: [],
  loopbackUrl: "ws://127.0.0.1:7766/v1/hc",
  token: "",
};

const KEY = "doriface.connection";

const memberOf = (value: unknown): MemberTarget | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (key: string): string => {
    const raw = Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
    return typeof raw === "string" ? raw : "";
  };
  const hostId = field("hostId");
  return hostId === ""
    ? undefined
    : { hostId, hostName: field("hostName"), hostKey: field("hostKey"), directUrl: field("directUrl") };
};

/**
 * The roster, from what was saved, always including the selected member.
 *
 * A file written before the roster existed has only the four flat fields, and one whose selected host is missing from its
 * own roster is repaired rather than losing the address this app is bound to.
 */
const rosterOf = (saved: unknown, selected: MemberTarget): readonly MemberTarget[] => {
  const listed = Array.isArray(saved) ? saved.flatMap((entry) => memberOf(entry) ?? []) : [];
  const others = listed.filter((member) => member.hostId !== selected.hostId);
  return selected.hostId === "" ? others : [selected, ...others];
};

/** Whether this is a dev build (vite dev): only a dev build may name another relay or switch to the loopback gateway. */
export const DEV_BUILD: boolean = import.meta.env.DEV === true;

/** The settings a build may use: a release build always reaches the production relay, whatever relay was saved. */
export function lockRelay(settings: ConnectionSettings, devBuild: boolean = DEV_BUILD): ConnectionSettings {
  return devBuild || settings.relayUrl === DEFAULT_RELAY_URL ? settings : { ...settings, relayUrl: DEFAULT_RELAY_URL };
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Reads stored settings; anything malformed falls back field by field to the defaults, and a release build drops a saved
 * custom relay address. Refused or missing storage (bun's test runner, which loads store.ts and with it this read) gives
 * the defaults (#490, #551).
 */
export function loadSettings(
  storage: StorageLike = guardedLocalStorage(),
  { devBuild = DEV_BUILD }: { readonly devBuild?: boolean } = {},
): ConnectionSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(KEY) ?? "null");
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_SETTINGS;
  const get = (key: string): unknown => (Object.hasOwn(parsed, key) ? Reflect.get(parsed, key) : undefined);
  const d = DEFAULT_SETTINGS;
  const selected: MemberTarget = {
    hostId: text(get("hostId"), d.hostId),
    hostName: text(get("hostName"), d.hostName),
    hostKey: text(get("hostKey"), d.hostKey),
    directUrl: text(get("directUrl"), d.directUrl),
  };
  return lockRelay(
    {
      mode: get("mode") === "loopback" ? "loopback" : "relay",
      relayUrl: text(get("relayUrl"), d.relayUrl),
      directUrl: selected.directUrl,
      hostId: selected.hostId,
      hostName: selected.hostName,
      hostKey: selected.hostKey,
      members: rosterOf(get("members"), selected),
      loopbackUrl: text(get("loopbackUrl"), d.loopbackUrl),
      token: text(get("token"), d.token),
    },
    devBuild,
  );
}

/** How a store records a change to the settings it holds; see the constructor of `ConnectionStore`. */
export type Saver = (settings: ConnectionSettings) => void;

export function saveSettings(settings: ConnectionSettings, storage: StorageLike = guardedLocalStorage()): void {
  storage.setItem(KEY, JSON.stringify(normalizeSettings(settings)));
}

/**
 * The settings with the roster rule applied, for the file AND for what the app keeps in memory.
 *
 * `saveSettings` alone was not enough: the store kept the caller's object as it arrived, so a settings object built by
 * pairing (which spreads the old one and changes the selected host) carried a roster without that host until a reload, while
 * the file it wrote carried one with it. One rule, applied once, for both (review of #994).
 */
export function normalizeSettings(settings: ConnectionSettings): ConnectionSettings {
  const selected: MemberTarget = {
    hostId: settings.hostId,
    hostName: settings.hostName,
    hostKey: settings.hostKey,
    directUrl: settings.directUrl,
  };
  return { ...settings, members: rosterOf(settings.members, selected) };
}

/**
 * Whether the link stays on this computer (the loopback gateway on 127.0.0.1, localhost or ::1), so a lost network
 * says nothing about it: the desktop app's "This computer" keeps working with Wi-Fi off.
 */
export function staysOnThisComputer(settings: ConnectionSettings): boolean {
  if (settings.mode !== "loopback") return false;
  let host: string;
  try {
    host = new URL(settings.loopbackUrl).hostname;
  } catch {
    return false;
  }
  return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Whether these settings name something to connect to. */
export function isConfigured(settings: ConnectionSettings): boolean {
  return settings.mode === "loopback"
    ? settings.token !== "" && settings.loopbackUrl !== ""
    : settings.hostId !== "" && settings.hostKey !== "";
}
