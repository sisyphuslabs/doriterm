import type { HcConnection } from "@doriface/client";

/**
 * The call a wake sends to prove an open link got no answer in time, so the link was dropped (#653). It names that call:
 * the link's heartbeats may have kept arriving, so this is not a silent link (#779).
 */
export class WakeProbeUnansweredError extends Error {
  override readonly name = "WakeProbeUnansweredError";
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`the host did not answer a check after the app woke (${method}, ${Math.round(timeoutMs / 1000)} s)`);
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

type Proved = (connection: HcConnection, proven: boolean) => void;

/**
 * The open links a wake is asking to prove themselves, for everything that writes into them (#1370). A key written into a
 * half-open socket is lost, and writing it again after a reconnect would type it twice when the socket was alive, so
 * input for a link listed here waits. `settle` says whether the link answered (write what waited) or not (it is being
 * dropped, and what waited goes to the next stream).
 */
export class UnprovenLinks {
  readonly #links = new Set<HcConnection>();
  readonly #listeners = new Set<Proved>();

  has(connection: HcConnection): boolean {
    return this.#links.has(connection);
  }

  start(connection: HcConnection): void {
    this.#links.add(connection);
  }

  settle(connection: HcConnection, proven: boolean): void {
    if (!this.#links.delete(connection)) return;
    for (const listener of this.#listeners) listener(connection, proven);
  }

  subscribe(listener: Proved): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/** The app's one list: its stores prove links into it, and its terminal views hold input by it. */
export const unprovenLinks = new UnprovenLinks();

/** The page events that mean "this page can work again", as the store needs them. */
export interface WakeSources {
  /** Registers a listener for `online` and `pageshow`. */
  readonly on: (type: "online" | "pageshow", listener: () => void) => void;
  /** How the page reports becoming visible, or undefined where there is no document. */
  readonly visibility: { readonly state: () => string; readonly listen: (listener: () => void) => void } | undefined;
}

/** The running page's own events: no document under a test runner or a worker, so visibility is simply absent there. */
export function pageWakeSources(): WakeSources {
  return {
    on: (type, listener) => {
      if (typeof addEventListener === "function") addEventListener(type, listener);
    },
    visibility:
      typeof document === "undefined"
        ? undefined
        : {
            state: () => document.visibilityState,
            listen: (listener) => document.addEventListener("visibilitychange", listener),
          },
  };
}

/**
 * Runs a waiting reconnect the moment the page can work again: the network came back, a page came out of the back/forward
 * cache, or a tab became visible. A phone returning from the background fires `visibilitychange` and `pageshow`, not
 * `online`, so listening for the network alone left it waiting out a back-off and a heartbeat before it noticed (#653).
 */
export function resumeOnWake(store: { retryNow(): void }, sources: WakeSources = pageWakeSources()): void {
  const wake = (): void => store.retryNow();
  sources.on("online", wake);
  sources.on("pageshow", wake);
  sources.visibility?.listen(() => {
    if (sources.visibility?.state() === "visible") wake();
  });
}
