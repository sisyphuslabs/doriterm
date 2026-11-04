import type { Foreground, Status, Terminal } from "./__generated__/hc-api.ts";
import { EVENT_DATA_GUARDS, isTerminal } from "./event-guards.ts";
import { isJsonObject } from "./json.ts";
import type { JsonRpcNotification } from "./jsonrpc.ts";

export interface TerminalEnd {
  readonly reason: string | null;
  readonly exit_code: number | null;
  readonly signal: number | null;
  readonly finished_ms: number | null;
}

/** `data` of each `event` notification type, as herdr-core's schema README documents it. */
export interface HcEventDataMap {
  readonly created: Terminal;
  readonly lost: TerminalEnd;
  readonly restarted: Terminal;
  readonly keep: { readonly keep: boolean };
  readonly finished: TerminalEnd;
  readonly removed: { readonly [key: string]: never };
  readonly status: {
    readonly status: Status | null;
    readonly records: { readonly [id: string]: Status };
    readonly reported: boolean;
  };
  readonly turn: { readonly turn: number; readonly state: string };
  readonly title: { readonly title: string };
  readonly labels: { readonly labels: { readonly [key: string]: string }; readonly record?: Terminal };
  readonly size: { readonly cols: number; readonly rows: number };
  readonly foreground: Foreground | null;
  readonly doc: { readonly name: string; readonly version: number };
}

export type HcEventType = keyof HcEventDataMap;

export type HcEvent = {
  readonly [K in HcEventType]: {
    readonly type: K;
    readonly seq: number;
    /** Absent for `doc` events. */
    readonly terminal?: string;
    /** Set when the change came from an added machine. */
    readonly machine?: string;
    readonly data: HcEventDataMap[K];
  };
}[HcEventType];

export interface HcSnapshot {
  readonly seq: number;
  readonly terminals: readonly Terminal[];
}

export type HcStreamMessage =
  | { readonly kind: "event"; readonly event: HcEvent }
  | { readonly kind: "heartbeat"; readonly seq: number }
  | { readonly kind: "missed"; readonly snapshot: HcSnapshot }
  | { readonly kind: "unknown"; readonly notification: JsonRpcNotification };

/**
 * Classifies one notification from an `events.subscribe` channel. Unknown methods and event
 * types newer than this schema come back as `unknown` instead of failing the stream.
 */
export function parseStreamNotification(notification: JsonRpcNotification): HcStreamMessage {
  const params = notification.params;
  switch (notification.method) {
    case "event":
      return isHcEvent(params) ? { kind: "event", event: params } : { kind: "unknown", notification };
    case "heartbeat":
      return isJsonObject(params) && isSeq(params["seq"])
        ? { kind: "heartbeat", seq: params["seq"] }
        : { kind: "unknown", notification };
    case "missed":
      return isSnapshot(params) ? { kind: "missed", snapshot: params } : { kind: "unknown", notification };
    default:
      return { kind: "unknown", notification };
  }
}

/** Remote terminals are addressed `machine/t7`; local ones by their bare id. */
export function eventAddress(event: HcEvent): string | undefined {
  if (event.terminal === undefined) return undefined;
  return event.machine === undefined || event.terminal.includes("/")
    ? event.terminal
    : `${event.machine}/${event.terminal}`;
}

export function isHcEvent(value: unknown): value is HcEvent {
  if (!isJsonObject(value)) return false;
  const type = value["type"];
  const terminal = value["terminal"];
  const machine = value["machine"];
  const data = value["data"];
  return (
    typeof type === "string" &&
    isEventType(type) &&
    isSeq(value["seq"]) &&
    (terminal === undefined || typeof terminal === "string") &&
    (machine === undefined || typeof machine === "string") &&
    EVENT_DATA_GUARDS[type](data)
  );
}

export function isSnapshot(value: unknown): value is HcSnapshot {
  if (!isJsonObject(value)) return false;
  const terminals = value["terminals"];
  return isSeq(value["seq"]) && Array.isArray(terminals) && terminals.every(isTerminal);
}

function isEventType(type: string): type is HcEventType {
  return Object.hasOwn(EVENT_DATA_GUARDS, type);
}

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
