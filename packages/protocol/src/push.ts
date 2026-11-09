/**
 * Web push (contract v1.7 "Push stream"): the notice a push carries, and the lines of a device's push stream. Shared by
 * the host that sends pushes, the app that subscribes, and the service worker that shows them.
 */
import { isJsonObject, type JsonObject } from "./json.ts";
import { type NoticeContext, parseNoticeContext } from "./notice-context.ts";

export const NOTICE_KINDS = ["input", "permission", "done", "error", "test"] as const;
/** What a notice says happened: an agent asks for input or for a permission, finished its turn, or failed. */
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** The kinds a device can turn off; `test` comes whenever the device asks for one. */
export const NOTICE_EVENTS = ["input", "permission", "done", "error"] as const;
export type NoticeEvent = (typeof NOTICE_EVENTS)[number];
export type NoticeEvents = { readonly [K in NoticeEvent]: boolean };
export const ALL_NOTICE_EVENTS: NoticeEvents = { input: true, permission: true, done: true, error: true };

export interface PushPrefs {
  readonly events: NoticeEvents;
  /** Machine ids (`local`, `machine:<name>`) whose terminals send this device no notice. */
  readonly muted: readonly string[];
}

export const DEFAULT_PUSH_PREFS: PushPrefs = { events: ALL_NOTICE_EVENTS, muted: [] };

/**
 * Everything a push payload holds: no title, status text, command, address or machine. The service worker shows a
 * fixed text per kind; what the notice is about is asked for over the E2EE push stream.
 */
export interface PushNotice {
  readonly v: 1;
  /** 22 base64url characters (16 random bytes); maps to a terminal only on the host. */
  readonly n: string;
  readonly k: NoticeKind;
  /** The host that sent it, so a device paired with several hosts asks the right one. */
  readonly h: string;
}

const NOTICE_ID = /^[\w-]{22}$/;
const HOST_ID = /^[a-z2-7]{26}$/;
const NOTICE_KEYS = ["h", "k", "n", "v"];

const isKind = (value: unknown): value is NoticeKind => NOTICE_KINDS.some((kind) => kind === value);

export const isNoticeId = (value: unknown): value is string => typeof value === "string" && NOTICE_ID.test(value);

/** A push payload, exactly: any other member, or a missing one, makes it no notice. */
export function parsePushNotice(value: unknown): PushNotice | undefined {
  if (!isJsonObject(value) || Object.keys(value).toSorted().join() !== NOTICE_KEYS.join()) return undefined;
  const { v, n, k, h } = value;
  if (v !== 1 || !isNoticeId(n) || !isKind(k) || typeof h !== "string" || !HOST_ID.test(h)) return undefined;
  return { v, n, k, h };
}

/** The machine id a notice's terminal is muted by: `local` for this host's core, `machine:<name>` for an added one. */
export const noticeMachineId = (machine: string | undefined): string =>
  machine === undefined ? "local" : `machine:${machine}`;

/** A line on the push stream is at most this many bytes, its LF included. */
export const MAX_PUSH_LINE = 4096;

export type PromptAnswer = "allow" | "deny";

/** A notice's prompt rows, as a notification may offer them as actions: a single-choice prompt's own rows. */
export interface NoticeOption {
  /** The row's number as the agent drew it. */
  readonly id: string;
  /** The agent's own label, at most MAX_NOTICE_LABEL characters. */
  readonly label: string;
  /** The agent's No row: answering it from a notification needs no look at the app. */
  readonly declines: boolean;
}

/**
 * What a notice's prompt offers a notification: its rows when it is one question answered by one key (no steps, no
 * boxes, no typed text), and nothing otherwise, where a tap opens the card.
 */
export interface NoticePrompt {
  readonly options: readonly NoticeOption[];
}

export const MAX_NOTICE_LABEL = 80;
export const MAX_NOTICE_OPTIONS = 8;
const OPTION_ID = /^\d{1,3}$/;

/** A browser's push subscription: its endpoint and its RFC 8291 keys, base64url. */
export interface PushSubscriptionKeys {
  readonly endpoint: string;
  /** The browser's P-256 public key, 65 bytes uncompressed. */
  readonly p256dh: string;
  /** The 16-byte authentication secret. */
  readonly auth: string;
}

export type PushClientLine =
  | { readonly t: "hello" }
  | { readonly t: "subscribe"; readonly subscription: PushSubscriptionKeys; readonly prefs: PushPrefs }
  | { readonly t: "prefs"; readonly endpoint: string; readonly prefs: PushPrefs }
  | { readonly t: "unsubscribe"; readonly endpoint: string }
  | { readonly t: "test"; readonly endpoint: string }
  | { readonly t: "focus"; readonly terminal: string | null }
  | { readonly t: "notice"; readonly id: string }
  | { readonly t: "answer"; readonly id: string; readonly answer: PromptAnswer }
  /** One row of a notice's prompt (its `NoticeOption.id`), answered with that row's own key. */
  | { readonly t: "choose"; readonly id: string; readonly option: string };

export interface HeldSubscription {
  readonly endpoint: string;
  readonly prefs: PushPrefs;
}

export type PushHostLine =
  | { readonly t: "ready"; readonly vapidKey: string; readonly subscriptions: readonly HeldSubscription[] }
  | { readonly t: "ok" }
  | {
      readonly t: "notice";
      readonly terminal: string | null;
      readonly kind: NoticeKind | null;
      /** A host that knows the prompt and can answer its rows says so; an older host never does. */
      readonly prompt?: NoticePrompt;
      /** What the notice is about, for the notification's own text (#1908); an older host sends none. */
      readonly context?: NoticeContext;
    }
  | { readonly t: "answered"; readonly terminal: string }
  | { readonly t: "stale"; readonly terminal: string | null }
  /** The answer did not go through (a dropped link, a lapsed claim): nothing was pressed. */
  | { readonly t: "failed"; readonly terminal: string | null; readonly reason: string }
  /** The key press itself failed after it was sent: it may have reached the agent. */
  | { readonly t: "unknown"; readonly terminal: string }
  | { readonly t: "error"; readonly reason: string };

export class PushLineError extends Error {
  override readonly name = "PushLineError";
}

const B64URL = /^[\w-]+$/;
const MAX_ENDPOINT = 1024;
const MAX_MUTED = 64;
const MAX_ID = 160;

function fail(reason: string): never {
  throw new PushLineError(reason);
}

const text = (value: unknown, max: number, what: string): string =>
  typeof value === "string" && value !== "" && value.length <= max ? value : fail(`${what} is not a string`);

const b64 = (value: unknown, length: number, what: string): string =>
  typeof value === "string" && value.length === length && B64URL.test(value) ? value : fail(`${what} is malformed`);

/** An endpoint the browser gave: an absolute http(s) URL; which origins the host posts to is the host's rule. */
function endpointOf(value: unknown): string {
  const endpoint = text(value, MAX_ENDPOINT, "endpoint");
  if (!URL.canParse(endpoint)) fail("endpoint is not a URL");
  const { protocol } = new URL(endpoint);
  return protocol === "https:" || protocol === "http:" ? endpoint : fail("endpoint is not an http(s) URL");
}

function prefsOf(value: unknown): PushPrefs {
  if (!isJsonObject(value)) fail("prefs is not an object");
  const { events, muted } = value;
  if (!isJsonObject(events)) fail("prefs.events is not an object");
  const flags = Object.fromEntries(
    NOTICE_EVENTS.map((event) => {
      const on = events[event];
      return [event, typeof on === "boolean" ? on : fail(`prefs.events.${event} is not a boolean`)];
    }),
  );
  if (!Array.isArray(muted) || muted.length > MAX_MUTED) fail("prefs.muted is not a list");
  return {
    events: {
      input: flags["input"] === true,
      permission: flags["permission"] === true,
      done: flags["done"] === true,
      error: flags["error"] === true,
    },
    muted: muted.map((id) => text(id, MAX_ID, "a muted machine")),
  };
}

function subscriptionOf(value: unknown): PushSubscriptionKeys {
  if (!isJsonObject(value)) fail("subscription is not an object");
  return {
    endpoint: endpointOf(value["endpoint"]),
    p256dh: b64(value["p256dh"], 87, "p256dh"),
    auth: b64(value["auth"], 22, "auth"),
  };
}

const terminalOf = (value: unknown): string | null => (value === null ? null : text(value, MAX_ID, "terminal"));

function objectLine(line: string): JsonObject & { readonly t: string } {
  if (new TextEncoder().encode(line).byteLength >= MAX_PUSH_LINE) fail("line too long");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return fail("not JSON");
  }
  if (!isJsonObject(value) || typeof value["t"] !== "string") fail("not an object with a string t");
  return { ...value, t: value["t"] };
}

/**
 * One client line (without its LF). Throws {@link PushLineError} for a line the stream must close on; a well-formed
 * line of an unknown `t` comes back as `unknown`, which the host answers with an error and keeps the stream.
 */
export function parsePushClientLine(line: string): PushClientLine | { readonly t: "unknown" } {
  const value = objectLine(line);
  switch (value.t) {
    case "hello":
      return { t: "hello" };
    case "subscribe":
      return { t: "subscribe", subscription: subscriptionOf(value["subscription"]), prefs: prefsOf(value["prefs"]) };
    case "prefs":
      return { t: "prefs", endpoint: endpointOf(value["endpoint"]), prefs: prefsOf(value["prefs"]) };
    case "unsubscribe":
    case "test":
      return { t: value.t, endpoint: endpointOf(value["endpoint"]) };
    case "focus":
      return { t: "focus", terminal: terminalOf(value["terminal"]) };
    case "notice":
      return { t: "notice", id: isNoticeId(value["id"]) ? value["id"] : fail("id is malformed") };
    case "choose": {
      const option = value["option"];
      return {
        t: "choose",
        id: isNoticeId(value["id"]) ? value["id"] : fail("id is malformed"),
        option: typeof option === "string" && OPTION_ID.test(option) ? option : fail("option is malformed"),
      };
    }
    case "answer": {
      const answer = value["answer"];
      return {
        t: "answer",
        id: isNoticeId(value["id"]) ? value["id"] : fail("id is malformed"),
        answer: answer === "allow" || answer === "deny" ? answer : fail("answer is neither allow nor deny"),
      };
    }
    default:
      return { t: "unknown" };
  }
}

/** A notice's prompt as the host sent it; anything malformed is no prompt, so the notification offers no rows. */
function promptOf(value: unknown): NoticePrompt | undefined {
  if (!isJsonObject(value) || !Array.isArray(value["options"])) return undefined;
  const options = value["options"].slice(0, MAX_NOTICE_OPTIONS).flatMap((entry): NoticeOption[] => {
    if (!isJsonObject(entry)) return [];
    const { id, label, declines } = entry;
    return typeof id === "string" && OPTION_ID.test(id) && typeof label === "string" && label !== ""
      ? [{ id, label: label.slice(0, MAX_NOTICE_LABEL), declines: declines === true }]
      : [];
  });
  return options.length === 0 ? undefined : { options };
}

/** One host line (without its LF), as the app and the service worker read it. */
export function parsePushHostLine(line: string): PushHostLine {
  const value = objectLine(line);
  switch (value.t) {
    case "ready": {
      const held = value["subscriptions"];
      if (!Array.isArray(held)) fail("subscriptions is not a list");
      return {
        t: "ready",
        vapidKey: b64(value["vapidKey"], 87, "vapidKey"),
        subscriptions: held.map((entry) =>
          isJsonObject(entry)
            ? { endpoint: endpointOf(entry["endpoint"]), prefs: prefsOf(entry["prefs"]) }
            : fail("a subscription is not an object"),
        ),
      };
    }
    case "ok":
      return { t: "ok" };
    case "notice": {
      const kind = value["kind"];
      const prompt = promptOf(value["prompt"]);
      const context = parseNoticeContext(value["context"]);
      return {
        t: "notice",
        terminal: terminalOf(value["terminal"]),
        kind: isKind(kind) ? kind : null,
        ...(prompt === undefined ? {} : { prompt }),
        ...(context === undefined ? {} : { context }),
      };
    }
    case "answered":
      return { t: "answered", terminal: text(value["terminal"], MAX_ID, "terminal") };
    case "stale":
      return { t: "stale", terminal: terminalOf(value["terminal"]) };
    case "failed":
      return {
        t: "failed",
        terminal: terminalOf(value["terminal"]),
        reason: typeof value["reason"] === "string" ? value["reason"] : "",
      };
    case "unknown":
      return { t: "unknown", terminal: text(value["terminal"], MAX_ID, "terminal") };
    case "error":
      return { t: "error", reason: typeof value["reason"] === "string" ? value["reason"] : "" };
    default:
      return fail(`unknown host line ${JSON.stringify(value.t)}`);
  }
}

/** Encodes a line of either side, LF included. */
export const encodePushLine = (line: PushClientLine | PushHostLine): string => `${JSON.stringify(line)}\n`;
