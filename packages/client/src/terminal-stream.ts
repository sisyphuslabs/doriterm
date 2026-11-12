import {
  encodeCredit,
  encodeResize,
  FrameKind,
  readResize,
  type AttachResult,
  type Display,
  type Frame,
  type Terminal,
} from "@doriface/protocol";
import { HcConnectionClosedError } from "./errors.ts";
import { Listeners, type Unsubscribe } from "./listeners.ts";
import { closeFromPayload, connectionClose, type StreamClose } from "./stream-close.ts";
import type { ChannelHandler } from "./wire.ts";

export interface StreamWire {
  sendBytes(bytes: Uint8Array): void;
  send(channel: number, kind: number, payload?: Uint8Array): void;
  /** A channel's CLOSE, which a closed or dead link just skips. */
  sendClose(channel: number): void;
  unregister(channel: number): void;
  /** The link went silent: true when it takes the loss and the connection stays (see ByteLink.lost). */
  lost?(reason: Error): boolean;
}

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

type Queued =
  | { readonly kind: "data"; readonly bytes: Uint8Array }
  | { readonly kind: "resize"; readonly size: TerminalSize };

const INPUT_CHUNK_BYTES = 16 * 1024;
const MAX_U16 = 0xffff;
const utf8 = new TextEncoder();

/**
 * One attached terminal channel. Output that arrives before the first `onData` listener is held,
 * so the first paint (which follows the attach reply immediately) is never lost.
 */
export class TerminalStream implements ChannelHandler {
  readonly channel: number;
  readonly terminal: Terminal;
  readonly attachResult: AttachResult;
  /** True when keystroke-free answers may go out as AUTOMATIC_INPUT (kind 6) instead of DATA. */
  readonly automaticInput: boolean;
  readonly autoCredit: boolean;
  readonly #wire: StreamWire;
  readonly #data = new Listeners<Uint8Array>();
  readonly #resize = new Listeners<TerminalSize>();
  readonly #closeListeners = new Listeners<StreamClose>();
  readonly #closed = Promise.withResolvers<StreamClose>();
  #queue: Queued[] | undefined = [];
  #uncredited = 0;
  #size: TerminalSize;
  #state: "open" | "closing" | "closed" = "open";
  #closeInfo: StreamClose | undefined;

  constructor(wire: StreamWire, result: AttachResult, automaticInput: boolean, autoCredit: boolean) {
    this.#wire = wire;
    this.channel = result.channel;
    this.terminal = result.terminal;
    this.attachResult = result;
    this.automaticInput = automaticInput;
    this.autoCredit = autoCredit;
    this.#size = { cols: result.terminal.cols, rows: result.terminal.rows };
  }

  get state(): "open" | "closing" | "closed" {
    return this.#state;
  }

  /** The grid this viewer last set, or the core last announced to an observer. */
  get size(): TerminalSize {
    return this.#size;
  }

  onData(listener: (bytes: Uint8Array) => void): Unsubscribe {
    const unsubscribe = this.#data.add(listener);
    const queued = this.#queue;
    this.#queue = undefined;
    for (const item of queued ?? []) this.#emit(item);
    return unsubscribe;
  }

  /** Core-to-observer RESIZE (granted `resize_notifications`): apply it before later data. */
  onResize(listener: (size: TerminalSize) => void): Unsubscribe {
    return this.#resize.add(listener);
  }

  onClose(listener: (close: StreamClose) => void): Unsubscribe {
    const info = this.#closeInfo;
    if (info === undefined) return this.#closeListeners.add(listener);
    queueMicrotask(() => listener(info));
    return () => {};
  }

  /** Human input. False when the stream is no longer open. */
  write(data: string | Uint8Array): boolean {
    return this.#input(FrameKind.Data, data);
  }

  /** Answers the viewer's terminal generated itself; sent as DATA when the path lacks kind 6. */
  writeAutomatic(data: string | Uint8Array): boolean {
    return this.#input(this.automaticInput ? FrameKind.AutomaticInput : FrameKind.Data, data);
  }

  resize(cols: number, rows: number): boolean {
    if (!isGridSide(cols) || !isGridSide(rows)) throw new RangeError(`grid ${cols}x${rows} is outside 1..${MAX_U16}`);
    if (this.#state !== "open") return false;
    if (!this.#sent(() => this.#wire.sendBytes(encodeResize(this.channel, cols, rows)))) return false;
    this.#size = { cols, rows };
    return true;
  }

  focus(gained: boolean): boolean {
    return this.#control(FrameKind.Focus, new Uint8Array([gained ? 1 : 0]));
  }

  facts(display: Display): boolean {
    return this.#control(FrameKind.Facts, utf8.encode(JSON.stringify(display)));
  }

  /** Returns credit for output the consumer has rendered. Only for streams with `autoCredit: false`. */
  consumed(bytes: number): void {
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > this.#uncredited) {
      throw new RangeError(`consumed(${bytes}) exceeds the ${this.#uncredited} uncredited bytes on this stream`);
    }
    this.#uncredited -= bytes;
    if (bytes > 0 && this.#state === "open") this.#sent(() => this.#wire.sendBytes(encodeCredit(this.channel, bytes)));
  }

  /** Detaches this viewer; resolves when the core confirms with its own CLOSE. */
  close(): Promise<StreamClose> {
    if (this.#state === "open") {
      this.#state = "closing";
      this.#wire.sendClose(this.channel);
    }
    return this.#closed.promise;
  }

  frame(frame: Frame): void {
    switch (frame.kind) {
      case FrameKind.Data:
        if (this.#state === "open") this.#deliver({ kind: "data", bytes: frame.payload });
        return;
      case FrameKind.Resize:
        if (this.#state === "open" && frame.payload.byteLength === 4) {
          this.#deliver({ kind: "resize", size: readResize(frame.payload) });
        }
        return;
      case FrameKind.Close:
        this.#finish(closeFromPayload(frame.payload, this.#state === "closing"));
        return;
      default:
        return;
    }
  }

  connectionClosed(error: Error | undefined): void {
    this.#finish(connectionClose(error));
  }

  #deliver(item: Queued): void {
    if (this.#queue === undefined) {
      this.#emit(item);
    } else {
      this.#queue.push(item.kind === "data" ? { kind: "data", bytes: item.bytes.slice() } : item);
    }
  }

  #emit(item: Queued): void {
    switch (item.kind) {
      case "data":
        this.#credit(item.bytes.byteLength);
        this.#data.emit(item.bytes);
        return;
      case "resize":
        this.#size = item.size;
        this.#resize.emit(item.size);
        return;
    }
  }

  #credit(bytes: number): void {
    if (bytes === 0 || this.#state !== "open") return;
    if (this.autoCredit) this.#sent(() => this.#wire.sendBytes(encodeCredit(this.channel, bytes)));
    else this.#uncredited += bytes;
  }

  #input(kind: number, data: string | Uint8Array): boolean {
    if (this.#state !== "open") return false;
    const bytes = typeof data === "string" ? utf8.encode(data) : data;
    for (let offset = 0; offset < bytes.byteLength; offset += INPUT_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + INPUT_CHUNK_BYTES);
      if (!this.#sent(() => this.#wire.send(this.channel, kind, chunk))) return false;
    }
    return true;
  }

  #control(kind: number, payload: Uint8Array): boolean {
    if (this.#state !== "open") return false;
    return this.#sent(() => this.#wire.send(this.channel, kind, payload));
  }

  /**
   * Sends on the wire; false when the link refused the write, as when its socket went away before the wire learned it
   * (the wire is closed now, and this stream with it). Callers read false as a stream that is no longer open, the
   * contract `write` already states; a thrown error here escaped as an uncaught page error (#403).
   */
  #sent(send: () => void): boolean {
    try {
      send();
      return true;
    } catch (error) {
      if (error instanceof HcConnectionClosedError) return false;
      throw error;
    }
  }

  #finish(info: StreamClose): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#closeInfo = info;
    this.#wire.unregister(this.channel);
    this.#closeListeners.emit(info);
    this.#closed.resolve(info);
  }
}

function isGridSide(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_U16;
}
