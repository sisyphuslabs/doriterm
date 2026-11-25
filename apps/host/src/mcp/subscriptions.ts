import {
  eventAddress,
  type EventsSubscribeParams,
  type HcEvent,
  type HcSnapshot,
  isJsonObject,
  type JsonObject,
} from "@doriface/protocol";

// hc's own event stream (`events.subscribe`), carried as MCP's two standards for it: core `subscriptions/listen` with
// terminal resources, and the Events extension's push delivery (`events/stream`). Each one is one `events.subscribe`
// on the session's own core connection, and ends with it.

const URI_PREFIX = "doriterm://terminal/";
const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
export const EVENTS_EXTENSION = "io.modelcontextprotocol/events";
const EVENT_NAME = "terminal.changed";
const HEARTBEAT_MS = { min: 5_000, default: 30_000, max: 60_000 } as const;

/** A terminal as an MCP resource: its address, which may name a machine (`box/t7`), kept whole in one path segment. */
export const terminalUri = (address: string): string => `${URI_PREFIX}${encodeURIComponent(address)}`;

/** The terminal address a `doriterm://terminal/...` URI names, or undefined for anything else. */
export function readResourceUri(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri.startsWith(URI_PREFIX)) return undefined;
  try {
    const address = decodeURIComponent(uri.slice(URI_PREFIX.length));
    return address === "" ? undefined : address;
  } catch {
    return undefined;
  }
}

export interface ListenFilter {
  /** The terminal resources asked for that this host serves; any other URI is left out of the acknowledgment. */
  readonly uris: readonly string[];
  readonly listChanged: boolean;
}

export function readListen(params: unknown): ListenFilter {
  const notifications = isJsonObject(params) ? params["notifications"] : undefined;
  const asked = isJsonObject(notifications) ? notifications["resourceSubscriptions"] : undefined;
  const uris = Array.isArray(asked) ? asked.filter((uri): uri is string => readResourceUri(uri) !== undefined) : [];
  const listChanged = isJsonObject(notifications) && notifications["resourcesListChanged"] === true;
  return { uris: [...new Set(uris)], listChanged };
}

export interface StreamRequest {
  readonly filter: EventsSubscribeParams;
  /** True when the client asked to resume from a cursor: hc keeps no history, so it starts from now and says so. */
  readonly truncated: boolean;
  readonly heartbeatMs: number;
}

interface StreamRefusal {
  readonly error: { readonly code: number; readonly message: string; readonly data?: object };
}

const invalid = (message: string): StreamRefusal => ({ error: { code: -32602, message } });

export function readStream(params: unknown): StreamRequest | StreamRefusal {
  if (!isJsonObject(params)) return invalid("Invalid params");
  if (params["name"] !== EVENT_NAME) return { error: { code: -32023, message: "NotFound", data: { kind: "event" } } };
  const args = params["arguments"] ?? {};
  if (!isJsonObject(args)) return invalid("arguments must be an object");
  const filter: { terminal?: string; children_of?: string; labels?: { [key: string]: string } } = {};
  for (const key of ["terminal", "children_of"] as const) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return invalid(`${key} must be a string`);
    filter[key] = value;
  }
  const labels = args["labels"];
  if (labels !== undefined && labels !== null) {
    if (!isJsonObject(labels) || !Object.values(labels).every((value) => typeof value === "string")) {
      return invalid("labels must map names to strings");
    }
    filter.labels = Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, String(value)]));
  }
  const cursor = params["cursor"];
  const asked = params["heartbeatMs"];
  const heartbeatMs =
    typeof asked === "number" && Number.isFinite(asked)
      ? Math.min(HEARTBEAT_MS.max, Math.max(HEARTBEAT_MS.min, Math.round(asked)))
      : HEARTBEAT_MS.default;
  return { filter, truncated: cursor !== undefined && cursor !== null, heartbeatMs };
}

/** The one event type this host offers in `events/list`. */
export const EVENT_TYPE = {
  name: EVENT_NAME,
  description:
    "A terminal changed: created, finished, lost, restarted, removed, its status or turn, title, labels, size or " +
    "foreground; or a shared document changed. Narrow it to one terminal, the children of one, or a set of labels.",
  delivery: ["push"],
  inputSchema: {
    type: "object",
    properties: {
      terminal: { type: "string", description: "Only this terminal (t7, or machine/t7)." },
      children_of: { type: "string", description: "Only children of this terminal." },
      labels: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Only terminals carrying all of these labels.",
      },
    },
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: {
      type: { type: "string", description: "created, finished, status, turn, title, labels, size, doc and so on." },
      terminal: { type: ["string", "null"], description: "The terminal's address; null for a document change." },
      data: { type: "object", description: "What changed, as herdr-core reports it." },
    },
    required: ["type", "terminal", "data"],
  },
} as const;

/** What a subscription needs of `HcConnection.subscribe`'s feed; an EventFeed is one. */
export interface HcFeed {
  readonly snapshot: HcSnapshot;
  onEvent(listener: (event: HcEvent) => void): unknown;
  onSnapshot(listener: (snapshot: HcSnapshot) => void): unknown;
  close(): void;
}

type Send = (message: JsonObject) => void;
const tagged = (id: string | number, params: JsonObject = {}): JsonObject => ({
  ...params,
  _meta: { [SUBSCRIPTION_ID]: id },
});
const notify = (method: string, id: string | number, params?: JsonObject): JsonObject => ({
  jsonrpc: "2.0",
  method,
  params: tagged(id, params),
});

/** The response that ends a subscription the host closed: it carries nothing but the subscription's id. */
export const ended = (id: string | number): JsonObject => ({
  jsonrpc: "2.0",
  id,
  result: { resultType: "complete", ...tagged(id) },
});

/** A terminal joining or leaving the list; everything else changes a terminal in place. */
const CHANGES_LIST = new Set(["created", "removed", "lost", "restarted"]);

/** Core `subscriptions/listen`: acknowledges first, then names the terminal resources that changed. */
export function serveListen(id: string | number, filter: ListenFilter, feed: HcFeed, send: Send): void {
  const watched = new Set(filter.uris);
  const acknowledged: JsonObject = filter.listChanged
    ? { resourceSubscriptions: [...watched], resourcesListChanged: true }
    : { resourceSubscriptions: [...watched] };
  send(notify("notifications/subscriptions/acknowledged", id, { notifications: acknowledged }));
  const updated = (uri: string): void => send(notify("notifications/resources/updated", id, { uri }));
  feed.onEvent((event) => {
    if (filter.listChanged && CHANGES_LIST.has(event.type)) send(notify("notifications/resources/list_changed", id));
    const address = eventAddress(event);
    const uri = address === undefined ? undefined : terminalUri(address);
    if (uri !== undefined && watched.has(uri)) updated(uri);
  });
  // The core dropped events for this subscriber: anything may have changed.
  feed.onSnapshot(() => {
    if (filter.listChanged) send(notify("notifications/resources/list_changed", id));
    for (const uri of watched) updated(uri);
  });
}

/** Starts a repeating callback and returns the stop; a test passes its own to beat on demand. */
export type Every = (ms: number, beat: () => void) => () => void;
export const realEvery: Every = (ms, beat) => {
  const timer = setInterval(beat, ms);
  return () => clearInterval(timer);
};

/**
 * The Events extension's push delivery: `active` first, then one `event` per hc event and a heartbeat at the granted
 * interval. hc keeps no history, so every cursor is null, and a core that dropped events announces it with a fresh
 * `active` that says `truncated`. Returns the stop for the heartbeat.
 */
export function serveStream(id: string | number, request: StreamRequest, feed: HcFeed, send: Send, every: Every) {
  const active = (truncated: boolean): void =>
    send(notify("notifications/events/active", id, { cursor: null, truncated, heartbeatMs: request.heartbeatMs }));
  active(request.truncated);
  feed.onEvent((event) => {
    send(
      notify("notifications/events/event", id, {
        eventId: `${event.machine ?? ""}:${event.seq}`,
        name: EVENT_NAME,
        timestamp: new Date().toISOString(),
        data: { type: event.type, terminal: eventAddress(event) ?? null, data: event.data as JsonObject },
        cursor: null,
      }),
    );
  });
  feed.onSnapshot(() => active(true));
  return every(request.heartbeatMs, () => send(notify("notifications/events/heartbeat", id, { cursor: null })));
}
