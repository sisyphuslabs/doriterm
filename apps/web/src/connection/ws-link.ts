import type { ByteLink, Unsubscribe } from "@doriface/client";

type DataListener = (bytes: Uint8Array) => void;
type CloseListener = (error: Error | undefined) => void;

/** Closed with a code the gateway or relay chose; `code` is the WebSocket close code. */
export class LinkCloseError extends Error {
  override readonly name = "LinkCloseError";
  readonly code: number;
  constructor(code: number, reason: string) {
    super(reason === "" ? `connection closed (${code})` : `${reason} (${code})`);
    this.code = code;
  }
}

/** The owner of an attempt cancelled it; its socket is closed and nothing it carried may be adopted. */
export class LinkAbortedError extends Error {
  override readonly name = "LinkAbortedError";
}

function listen<T>(set: Set<T>, listener: T): Unsubscribe {
  set.add(listener);
  return () => set.delete(listener);
}

export interface LinkOptions {
  readonly timeoutMs?: number;
  /** Cancels the attempt: a socket still connecting is closed, and one that opened is closed too (#446 §2). */
  readonly signal?: AbortSignal | undefined;
  /** Sends a text `ping` this often while the socket is open, for a host that closes a silent socket; off when unset. */
  readonly pingIntervalMs?: number | undefined;
}

/**
 * Opens a binary WebSocket and resolves once it is open; one message carries one chunk of bytes. A signal closes the
 * socket at any stage: while connecting (the promise rejects with {@link LinkAbortedError}) and after opening.
 */
export function openWebSocketLink(
  url: string,
  protocols: readonly string[],
  options: LinkOptions = {},
): Promise<ByteLink> {
  const { timeoutMs = 10_000, signal, pingIntervalMs } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new LinkAbortedError(`the ${url} attempt was cancelled`));
      return;
    }
    const socket = new WebSocket(url, [...protocols]);
    socket.binaryType = "arraybuffer";
    const data = new Set<DataListener>();
    const closes = new Set<CloseListener>();
    const held: Uint8Array[] = [];
    let ended = false;
    let opened = false;
    let pings: ReturnType<typeof setInterval> | undefined;
    const stop = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      stop();
      socket.close();
      reject(new Error(`no answer from ${url} within ${timeoutMs} ms`));
    }, timeoutMs);
    const onAbort = (): void => {
      stop();
      ended = true;
      socket.close();
      if (!opened) reject(new LinkAbortedError(`the ${url} attempt was cancelled`));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const link: ByteLink = {
      send: (bytes) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(new Uint8Array(bytes));
      },
      onData: (listener) => {
        const off = listen(data, listener);
        for (const chunk of held.splice(0)) listener(chunk);
        return off;
      },
      onClose: (listener) => listen(closes, listener),
      close: () => socket.close(1000),
    };

    socket.addEventListener("open", () => {
      // Only the attempt's deadline ends here: a cancellation still closes a socket that opened, so its abort listener
      // stays until the socket closes (#446 §2).
      clearTimeout(timer);
      opened = true;
      if (signal?.aborted === true) {
        socket.close();
        reject(new LinkAbortedError(`the ${url} attempt was cancelled`));
        return;
      }
      if (pingIntervalMs !== undefined)
        pings = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send("ping");
        }, pingIntervalMs);
      resolve(link);
    });
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const chunk = new Uint8Array(event.data);
      if (data.size === 0) held.push(chunk);
      for (const listener of data) listener(chunk);
    });
    socket.addEventListener("close", (event) => {
      stop();
      clearInterval(pings);
      if (ended) return;
      ended = true;
      const error = event.code === 1000 ? undefined : new LinkCloseError(event.code, event.reason);
      if (!opened) reject(error ?? new Error("closed before opening"));
      for (const listener of closes) listener(error);
    });
  });
}
