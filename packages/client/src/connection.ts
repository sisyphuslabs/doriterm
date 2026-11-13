import {
  encodeNotification,
  encodeRequest,
  isJsonObject,
  isSnapshot,
  isTerminal,
  type EmptyParams,
  type Frame,
  type HcMethod,
  type HcParams,
  type HcResult,
  type HelloResult,
  type EventsSubscribeParams,
  type JsonRpcNotification,
  type TerminalAttachParams,
} from "@doriface/protocol";
import { raceDeadline } from "./deadline.ts";
import {
  HcConnectionClosedError,
  HcHandshakeTimeoutError,
  HcLinkSilentError,
  HcProtocolError,
  HcTimeoutError,
} from "./errors.ts";
import type { ByteLink } from "./link.ts";
import type { Unsubscribe } from "./listeners.ts";
import { EventFeed } from "./event-feed.ts";
import { RttEstimator, type RttEstimate } from "./rtt.ts";
import { TerminalStream } from "./terminal-stream.ts";
import { isStreamChannel, Wire } from "./wire.ts";

export interface HcConnectionOptions {
  /** Default 10 000 ms. */
  readonly handshakeTimeoutMs?: number;
  /** The hello line already went out (inside the Noise handshake's first message, #1271): only its answer is read. */
  readonly helloSent?: boolean;
  readonly signal?: AbortSignal;
  /**
   * Applied to calls that pass no `timeoutMs`. Default: DEFAULT_CALL_TIMEOUT_MS for calls hc answers at once, and none
   * for WAITING_METHODS, which wait by design. `Infinity` turns the deadline off.
   */
  readonly callTimeoutMs?: number;
}

export interface CallOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface AttachOptions extends CallOptions {
  /** Return credit as soon as output is delivered (default true). False: call `consumed(n)` after rendering. */
  readonly autoCredit?: boolean;
}

export interface SubscribeOptions extends CallOptions {
  /** Close the feed after this much silence (default 45 000 ms, three missed heartbeats); 0 disables. */
  readonly heartbeatTimeoutMs?: number;
}

/** Params may be omitted only for methods whose params are all optional. */
export type CallArgs<M extends HcMethod> = [HcParams<M>] extends [EmptyParams]
  ? readonly [params?: EmptyParams, options?: CallOptions]
  : Partial<HcParams<M>> extends HcParams<M>
    ? readonly [params?: HcParams<M>, options?: CallOptions]
    : readonly [params: HcParams<M>, options?: CallOptions];

/** Frame-level access for passthrough tooling: every incoming frame, and sending any frame. */
export interface RawFrames {
  onFrame(listener: (frame: Frame) => void): Unsubscribe;
  send(channel: number, kind: number, payload?: Uint8Array): void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * How long a call hc answers at once may go unanswered before it fails with HcTimeoutError: well past an End's
 * hangup-terminate-kill (about a second), short enough that a stalled uplink under live heartbeats is reported.
 */
export const DEFAULT_CALL_TIMEOUT_MS = 20_000;

/** Calls that wait by design (for a program, a quiet terminal or a machine's dial), so no default deadline cuts them short. */
export const WAITING_METHODS: ReadonlySet<HcMethod> = new Set<HcMethod>([
  "terminal.wait",
  "terminal.run",
  "terminal.send",
  "terminal.keys",
  "terminal.interrupt",
  "terminal.put",
  "machine.exec",
  "machine.add",
  "machine.connect",
  "server.stop",
  "server.restart",
]);
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;

/** One framed herdr-core connection over a ByteLink. */
export class HcConnection {
  readonly hello: HelloResult;
  readonly features: ReadonlySet<string>;
  readonly raw: RawFrames;
  readonly #wire: Wire;
  readonly #rtt = new RttEstimator();
  readonly #callTimeoutMs: number | undefined;

  private constructor(wire: Wire, hello: HelloResult, callTimeoutMs: number | undefined) {
    this.#wire = wire;
    this.#callTimeoutMs = callTimeoutMs;
    this.hello = hello;
    this.features = new Set(hello.features);
    this.raw = {
      onFrame: (listener) => wire.incoming.add(listener),
      send: (channel, kind, payload) => wire.send(channel, kind, payload),
    };
  }

  /** Sends the framed `hello` and resolves once the core switched to frames. Closes the link on failure. */
  static async open(link: ByteLink, options: HcConnectionOptions = {}): Promise<HcConnection> {
    const wire = new Wire(link);
    const timeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    try {
      if (options.helloSent !== true) wire.start();
      const hello = await raceDeadline(
        wire.hello,
        { timeoutMs, signal: options.signal },
        () => new HcHandshakeTimeoutError(timeoutMs),
      );
      return new HcConnection(wire, hello, options.callTimeoutMs);
    } catch (error) {
      wire.close(error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /** Calls run concurrently; each resolves with its typed result or rejects with HcRpcError. */
  call<M extends HcMethod>(method: M, ...args: CallArgs<M>): Promise<HcResult<M>> {
    const [params, options] = args;
    return this.#request(method, params ?? {}, options ?? {}, (result) => result);
  }

  /** Attaches as a viewer. Kind 6 is used only when both the core and this attach path offer it. */
  attach(params: TerminalAttachParams, options: AttachOptions = {}): Promise<TerminalStream> {
    return this.#request("terminal.attach", params, options, (result) => {
      if (!isStreamChannel(result.channel) || !isTerminal(result.terminal)) {
        throw new HcProtocolError("terminal.attach replied without a stream channel and terminal");
      }
      const automaticInput = this.features.has("automatic_input") && result.automatic_input === true;
      const stream = new TerminalStream(this.#wire, result, automaticInput, options.autoCredit ?? true);
      this.#wire.register(result.channel, stream);
      return stream;
    });
  }

  /** Subscribes to terminal facts: a snapshot, then ordered events on a dedicated channel. */
  subscribe(filter: EventsSubscribeParams = {}, options: SubscribeOptions = {}): Promise<EventFeed> {
    return this.#request("events.subscribe", filter, options, (result) => {
      const channel = result.channel;
      if (!isStreamChannel(channel) || !isSnapshot(result)) {
        throw new HcProtocolError("events.subscribe replied without a stream channel and snapshot");
      }
      const snapshot = { seq: result.seq, terminals: result.terminals };
      const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
      const feed = new EventFeed(this.#wire, channel, snapshot, heartbeatTimeoutMs);
      this.#wire.register(channel, feed);
      // The core beats on every feed; when the beats stop, the link under them is gone even if no reset arrived
      // (Wi-Fi gone, a NAT timeout): close the connection, so its owner reconnects instead of waiting on TCP.
      feed.onClose((info) => {
        if (info.reason === "heartbeat_timeout") this.#wire.close(new HcLinkSilentError(heartbeatTimeoutMs));
      });
      return feed;
    });
  }

  /** `adopt` runs synchronously on the reply, before any later frame is dispatched. */
  #request<M extends HcMethod, T>(
    method: M,
    params: object,
    options: CallOptions,
    adopt: (result: HcResult<M>) => T,
  ): Promise<T> {
    if (this.#wire.isClosed) return Promise.reject(new HcConnectionClosedError("connection is closed"));
    const signal = options.signal;
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    // A test hook, as the attach log is: a spec sets globalThis.__dorifaceRpcLog and reads which calls a page made and
    // when. Inert in the product, where nothing sets it.
    const rpcLog: unknown = Reflect.get(globalThis, "__dorifaceRpcLog");
    if (Array.isArray(rpcLog)) rpcLog.push(method);
    const sentAt = this.#rtt.mark();
    const { id, promise } = this.#wire.calls.start(
      (result) => {
        if (!isResultOf(method, result)) throw new HcProtocolError(`${method} replied with a non-object result`);
        return adopt(result);
      },
      () => this.#answered(method, sentAt),
    );
    try {
      this.#wire.sendRpc(encodeRequest(id, method, params));
    } catch (error) {
      if (this.#wire.isClosed) return promise;
      this.#wire.calls.forget(id);
      return Promise.reject(error);
    }
    const timeoutMs =
      options.timeoutMs ?? this.#callTimeoutMs ?? (WAITING_METHODS.has(method) ? undefined : DEFAULT_CALL_TIMEOUT_MS);
    return raceDeadline(
      promise,
      { timeoutMs, signal },
      () => new HcTimeoutError(method, timeoutMs ?? 0),
      () => this.#cancel(id),
    );
  }

  #cancel(id: number): void {
    this.#wire.calls.forget(id);
    if (this.#wire.isClosed) return;
    try {
      this.#wire.sendRpc(encodeNotification("$/cancelRequest", { id }));
    } catch (error) {
      if (!(error instanceof HcConnectionClosedError)) throw error;
    }
  }

  /** A call the core answered: a round trip, unless the call waits by design and its time is the program's work. */
  #answered(method: HcMethod, sentAt: number): void {
    if (!WAITING_METHODS.has(method)) this.#rtt.sample(sentAt);
  }

  get closed(): boolean {
    return this.#wire.isClosed;
  }

  /**
   * The measured round trip of the calls the core answered (design D7): one number for the wake probe's deadline, the
   * replay quiet window and the predictor's display gate. `undefined` until the first answer arrives.
   */
  get rtt(): RttEstimate | undefined {
    return this.#rtt.estimate;
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): Unsubscribe {
    return this.#wire.notifications.add(listener);
  }

  /** `error` is undefined after `close()`, and set when the link or the protocol failed. */
  onClose(listener: (error: Error | undefined) => void): Unsubscribe {
    if (this.#wire.isClosed) {
      const error = this.#wire.closeError;
      queueMicrotask(() => listener(error));
      return () => {};
    }
    return this.#wire.closed.add(listener);
  }

  close(): void {
    this.#wire.close();
  }
}

/** Every hc result is a JSON object; fields are not checked because cores of other versions differ. */
function isResultOf<M extends HcMethod>(_method: M, value: unknown): value is HcResult<M> {
  return isJsonObject(value);
}
