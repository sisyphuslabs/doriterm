export type Unsubscribe = () => void;

/**
 * The byte pipe `secureLink` wraps and returns: structurally `@doriface/client`'s ByteLink. `close` may take a
 * WebSocket close code, which transports that have one honor and others ignore.
 */
export interface ByteLink {
  send(bytes: Uint8Array): void;
  onData(listener: (bytes: Uint8Array) => void): Unsubscribe;
  onClose(listener: (error: Error | undefined) => void): Unsubscribe;
  close(code?: number, reason?: string): void;
}

export const CloseCode = {
  CryptoFailure: 4400,
  UnknownDevice: 4401,
  RelayAuthFailed: 4403,
  HostOffline: 4404,
  IdleTimeout: 4408,
  /** A typed-code mesh join refused for any reason but the code opening a device pairing (that one stays 4401). */
  MeshCodeRefused: 4411,
  /** A resume that cannot be honoured (contract v1.11): another dial meets the same answer, so a new session is opened. */
  ResumeRefused: 4413,
  RateLimited: 4429,
} as const;

export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];

/** Why a secure link failed or was closed; `code` is the WebSocket close code that went (or came) over the wire. */
export class SecureLinkError extends Error {
  override readonly name = "SecureLinkError";
  readonly code: number | undefined;

  constructor(code: number | undefined, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** The close code a transport attached to its close error, if any (e.g. `{ code: 4401 }`). */
export function closeCodeOf(error: Error | undefined): number | undefined {
  if (error === undefined || !("code" in error)) return undefined;
  return typeof error.code === "number" ? error.code : undefined;
}

/** A set of listeners where one throwing listener cannot stop the others; its error resurfaces on a microtask. */
export class Listeners<T> {
  readonly #listeners = new Set<(value: T) => void>();

  get size(): number {
    return this.#listeners.size;
  }

  add(listener: (value: T) => void): Unsubscribe {
    const wrapped = (value: T): void => listener(value);
    this.#listeners.add(wrapped);
    return () => {
      this.#listeners.delete(wrapped);
    };
  }

  emit(value: T): void {
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener(value);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
}
