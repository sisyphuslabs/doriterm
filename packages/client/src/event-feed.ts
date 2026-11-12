import {
  encodeCredit,
  FrameKind,
  LineDecoder,
  parseJsonRpc,
  parseStreamNotification,
  type Frame,
  type HcEvent,
  type HcSnapshot,
  type JsonRpcNotification,
} from "@doriface/protocol";
import { HcLinkSilentError, HcProtocolError } from "./errors.ts";
import { Listeners, type Unsubscribe } from "./listeners.ts";
import type { StreamWire } from "./terminal-stream.ts";
import type { ChannelHandler } from "./wire.ts";

export interface FeedClose {
  readonly reason: "detached" | "closed_by_core" | "heartbeat_timeout" | "connection_closed" | "protocol_error";
  readonly error?: Error;
}

type Delivery =
  | { readonly kind: "event"; readonly event: HcEvent }
  | { readonly kind: "snapshot"; readonly snapshot: HcSnapshot }
  | { readonly kind: "unknown"; readonly notification: JsonRpcNotification };

/**
 * An `events.subscribe` channel: a snapshot, then events in `seq` order. Events at or below the
 * current snapshot's `seq` are dropped, `missed` replaces the snapshot, and silence longer than
 * the heartbeat timeout (the core beats every 15 s) closes the feed.
 */
export class EventFeed implements ChannelHandler {
  readonly channel: number;
  readonly #wire: StreamWire;
  readonly #lines = new LineDecoder();
  readonly #events = new Listeners<HcEvent>();
  readonly #snapshots = new Listeners<HcSnapshot>();
  readonly #unknown = new Listeners<JsonRpcNotification>();
  readonly #closeListeners = new Listeners<FeedClose>();
  readonly #heartbeatTimeoutMs: number;
  #queue: Delivery[] | undefined = [];
  #heldCredit = 0;
  #snapshot: HcSnapshot;
  #seq: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closeInfo: FeedClose | undefined;

  constructor(wire: StreamWire, channel: number, snapshot: HcSnapshot, heartbeatTimeoutMs: number) {
    this.#wire = wire;
    this.channel = channel;
    this.#snapshot = snapshot;
    this.#seq = snapshot.seq;
    this.#heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.#armHeartbeat();
  }

  /** The latest snapshot: the subscribe reply, or the last `missed` replacement. */
  get snapshot(): HcSnapshot {
    return this.#snapshot;
  }

  get seq(): number {
    return this.#seq;
  }

  get closed(): boolean {
    return this.#closeInfo !== undefined;
  }

  /**
   * Events that arrived before the first listener are delivered to it, in order. Until then the
   * feed returns no credit, so the core holds further events instead of this client buffering them.
   */
  onEvent(listener: (event: HcEvent) => void): Unsubscribe {
    const unsubscribe = this.#events.add(listener);
    const queued = this.#queue;
    this.#queue = undefined;
    for (const delivery of queued ?? []) this.#emit(delivery);
    const held = this.#heldCredit;
    this.#heldCredit = 0;
    if (held > 0 && this.#closeInfo === undefined) this.#wire.sendBytes(encodeCredit(this.channel, held));
    return unsubscribe;
  }

  /** The core fell behind and sent a fresh snapshot: replace local state with it. */
  onSnapshot(listener: (snapshot: HcSnapshot) => void): Unsubscribe {
    return this.#snapshots.add(listener);
  }

  /** Notifications this client does not understand (a newer core). */
  onUnknown(listener: (notification: JsonRpcNotification) => void): Unsubscribe {
    return this.#unknown.add(listener);
  }

  onClose(listener: (close: FeedClose) => void): Unsubscribe {
    const info = this.#closeInfo;
    if (info === undefined) return this.#closeListeners.add(listener);
    queueMicrotask(() => listener(info));
    return () => {};
  }

  close(): void {
    this.#end({ reason: "detached" }, true);
  }

  frame(frame: Frame): void {
    if (this.#closeInfo !== undefined) return;
    switch (frame.kind) {
      case FrameKind.Data:
        this.#armHeartbeat();
        this.#data(frame.payload);
        return;
      case FrameKind.Close:
        this.#end({ reason: "closed_by_core" }, false);
        return;
      default:
        return;
    }
  }

  connectionClosed(error: Error | undefined): void {
    this.#end(error === undefined ? { reason: "connection_closed" } : { reason: "connection_closed", error }, false);
  }

  #data(payload: Uint8Array): void {
    try {
      for (const line of this.#lines.push(payload)) {
        if (this.#closeInfo !== undefined) return;
        this.#line(line);
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new HcProtocolError(String(error));
      this.#end({ reason: "protocol_error", error: failure }, true);
      return;
    }
    if (this.#closeInfo !== undefined || payload.byteLength === 0) return;
    if (this.#queue === undefined) this.#wire.sendBytes(encodeCredit(this.channel, payload.byteLength));
    else this.#heldCredit += payload.byteLength;
  }

  #line(line: string): void {
    if (line.trim() === "") return;
    const message = parseJsonRpc(line);
    if (message.kind !== "notification") throw new HcProtocolError(`event channel carried a ${message.kind}`);
    const parsed = parseStreamNotification(message);
    switch (parsed.kind) {
      case "event":
        if (parsed.event.seq <= this.#seq) return;
        this.#seq = parsed.event.seq;
        this.#deliver({ kind: "event", event: parsed.event });
        return;
      case "heartbeat":
        return;
      case "missed":
        this.#snapshot = parsed.snapshot;
        this.#seq = parsed.snapshot.seq;
        this.#deliver({ kind: "snapshot", snapshot: parsed.snapshot });
        return;
      case "unknown":
        this.#deliver({ kind: "unknown", notification: parsed.notification });
        return;
    }
  }

  #deliver(delivery: Delivery): void {
    if (this.#queue === undefined) this.#emit(delivery);
    else this.#queue.push(delivery);
  }

  #emit(delivery: Delivery): void {
    switch (delivery.kind) {
      case "event":
        this.#events.emit(delivery.event);
        return;
      case "snapshot":
        this.#snapshots.emit(delivery.snapshot);
        return;
      case "unknown":
        this.#unknown.emit(delivery.notification);
        return;
    }
  }

  #armHeartbeat(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#heartbeatTimeoutMs <= 0) return;
    this.#timer = setTimeout(() => this.#silent(), this.#heartbeatTimeoutMs);
  }

  /**
   * The beats stopped. A link that can carry the session on over a new socket takes the loss and the feed waits for
   * the beats to come back with it (the core kept beating into the host, which holds them for the resume); any other
   * link is gone, so the feed closes and its owner reconnects.
   */
  #silent(): void {
    if (this.#wire.lost?.(new HcLinkSilentError(this.#heartbeatTimeoutMs)) === true) return this.#armHeartbeat();
    this.#end({ reason: "heartbeat_timeout" }, true);
  }

  #end(info: FeedClose, sendClose: boolean): void {
    if (this.#closeInfo !== undefined) return;
    this.#closeInfo = info;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#wire.unregister(this.channel);
    if (sendClose) this.#wire.sendClose(this.channel);
    this.#closeListeners.emit(info);
  }
}
