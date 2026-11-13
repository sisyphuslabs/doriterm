import {
  decodeJsonRpc,
  encodeFailure,
  encodeFrame,
  FrameDecoder,
  FrameKind,
  RPC_CHANNEL,
  type Frame,
  isJsonObject,
  type HelloResult,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from "@doriface/protocol";
import { PendingCalls } from "./calls.ts";
import { HcConnectionClosedError } from "./errors.ts";
import { HELLO_REQUEST_LINE, HelloReader } from "./hello.ts";
import type { ByteLink } from "./link.ts";
import { Listeners, type Unsubscribe } from "./listeners.ts";

export interface ChannelHandler {
  frame(frame: Frame): void;
  connectionClosed(error: Error | undefined): void;
}

const utf8 = new TextEncoder();
const MAX_CHANNEL = 0xffffffff;

export function isStreamChannel(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > RPC_CHANNEL && value <= MAX_CHANNEL;
}

/** Owns one link: the plain-mode hello, then frame decoding and routing by channel. */
export class Wire {
  readonly incoming = new Listeners<Frame>();
  readonly notifications = new Listeners<JsonRpcNotification>();
  readonly closed = new Listeners<Error | undefined>();
  readonly calls = new PendingCalls();
  readonly hello: Promise<HelloResult>;
  readonly #link: ByteLink;
  readonly #helloReader = new HelloReader();
  readonly #frames = new FrameDecoder();
  readonly #channels = new Map<number, ChannelHandler>();
  readonly #helloSettle: PromiseWithResolvers<HelloResult>;
  readonly #linkListeners: readonly Unsubscribe[];
  #framed = false;
  #closeState: { readonly error: Error | undefined } | undefined;

  constructor(link: ByteLink) {
    this.#link = link;
    this.#helloSettle = Promise.withResolvers<HelloResult>();
    this.hello = this.#helloSettle.promise;
    this.#linkListeners = [
      link.onData((chunk) => this.#receive(chunk)),
      link.onClose((error) => this.#shutdown(error ?? new HcConnectionClosedError("link closed"))),
    ];
  }

  /** Sends the hello line. A link that refuses it closes the wire, which rejects `hello` with the cause. */
  start(): void {
    try {
      this.sendBytes(utf8.encode(HELLO_REQUEST_LINE));
    } catch (error) {
      if (!(error instanceof HcConnectionClosedError)) throw error;
    }
  }

  get isClosed(): boolean {
    return this.#closeState !== undefined;
  }

  get closeError(): Error | undefined {
    return this.#closeState?.error;
  }

  send(channel: number, kind: number, payload?: Uint8Array): void {
    this.sendBytes(encodeFrame(channel, kind, payload));
  }

  /** Sends bytes that already form whole frames. */
  sendBytes(bytes: Uint8Array): void {
    if (this.#closeState !== undefined) throw new HcConnectionClosedError("connection is closed");
    try {
      this.#link.send(bytes);
    } catch (error) {
      const failure = error instanceof Error ? error : new HcConnectionClosedError(String(error));
      this.close(failure);
      throw new HcConnectionClosedError("the link refused a write", { cause: failure });
    }
  }

  /**
   * Tells the core a channel is done. On a closed wire, or one whose socket went away before it said so, there is no
   * core to tell and nothing to throw: closing a feed or a stream as a dropped link tears down is never an error (#403).
   */
  sendClose(channel: number): void {
    if (this.#closeState !== undefined) return;
    try {
      this.send(channel, FrameKind.Close);
    } catch (error) {
      if (!(error instanceof HcConnectionClosedError)) throw error;
    }
  }

  sendRpc(text: string): void {
    this.send(RPC_CHANNEL, FrameKind.Data, utf8.encode(text));
  }

  register(channel: number, handler: ChannelHandler): void {
    if (!isStreamChannel(channel)) throw new RangeError(`stream channel ${channel} is not a uint32 above 0`);
    this.#channels.set(channel, handler);
  }

  unregister(channel: number): void {
    this.#channels.delete(channel);
  }

  close(error?: Error): void {
    if (this.#closeState !== undefined) return;
    this.#shutdown(error);
    this.#link.close();
  }

  /** Hands a silence to the link: true when it can carry the connection on and took the loss. */
  lost(reason: Error): boolean {
    return this.#closeState === undefined && this.#link.lost?.(reason) === true;
  }

  #receive(chunk: Uint8Array): void {
    if (this.#closeState !== undefined) return;
    try {
      let framed = chunk;
      if (!this.#framed) {
        const step = this.#helloReader.push(chunk);
        if (!step.done) return;
        this.#framed = true;
        this.#helloSettle.resolve(step.hello);
        framed = step.framedBytes;
      }
      for (const frame of this.#frames.push(framed)) {
        if (this.#closeState !== undefined) return;
        this.#dispatch(frame);
      }
    } catch (error) {
      this.close(error instanceof Error ? error : new HcConnectionClosedError(String(error)));
    }
  }

  #dispatch(frame: Frame): void {
    this.incoming.emit(frame);
    if (frame.channel !== RPC_CHANNEL) {
      this.#channels.get(frame.channel)?.frame(frame);
      return;
    }
    if (frame.kind === FrameKind.Data) this.#rpc(decodeJsonRpc(frame.payload));
  }

  #rpc(message: JsonRpcMessage): void {
    switch (message.kind) {
      case "notification":
        this.notifications.emit(message);
        return;
      case "request":
        this.sendRpc(
          encodeFailure(message.id, {
            code: -32601,
            message: `this client serves no method ${message.method}`,
            data: { kind: "unknown_method" },
          }),
        );
        return;
      case "success":
      case "failure":
        if (!this.calls.settle(message)) this.#orphanReply(message);
        return;
    }
  }

  /** A reply nobody waits for any more. If it opened a stream, close it so the core frees it. */
  #orphanReply(response: JsonRpcResponse): void {
    if (response.kind !== "success" || !isJsonObject(response.result)) return;
    const channel = response.result["channel"];
    if (isStreamChannel(channel)) this.sendClose(channel);
  }

  #shutdown(error: Error | undefined): void {
    if (this.#closeState !== undefined) return;
    this.#closeState = { error };
    for (const unsubscribe of this.#linkListeners) unsubscribe();
    const reason = error ?? new HcConnectionClosedError("connection closed");
    this.#helloSettle.reject(reason);
    this.calls.failAll(reason);
    const handlers = [...this.#channels.values()];
    this.#channels.clear();
    for (const handler of handlers) handler.connectionClosed(error);
    this.closed.emit(error);
  }
}
