import { raceFastest } from "./fastest.ts";
import { RelayCloseError } from "./link.ts";
import type { RelayProofs } from "./pass-book.ts";
import { type CreateSocket, defaultCreateSocket, relaySocketUrl, roomRoundTrip } from "./socket.ts";
import { WebSocketLink } from "./websocket-link.ts";
import {
  CloseCode,
  CREDIT_QUERY,
  HOST_ID_PATTERN,
  PAIR_SLOT_PATTERN,
  PING_INTERVAL_MS,
  PROOF_QUERY,
  relayOriginOf,
} from "./wire/index.ts";

export interface ClientConnectOptions {
  /** e.g. `https://relay-doriface.omo.dev`. */
  readonly relayUrl: string;
  readonly hostId: string;
  /**
   * The pairing slot when this session runs the IKpsk2 pairing handshake. The relay admits at most 10 pairing
   * sessions per slot per 10 minutes, and only to the host that holds the slot.
   */
  readonly pairSlot?: string;
  readonly pingIntervalMs?: number;
  readonly createSocket?: CreateSocket;
  /** How long the socket has to open, so a relay that never answers cannot hold a connect open; default {@link RELAY_CONNECT_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  /** The caller's own cancellation: the socket is closed and the connect rejects with its reason. */
  readonly signal?: AbortSignal | undefined;
  /** A host's relay passes (contract v1.6): the session carries a proof when one is available. */
  readonly proofs?: Pick<RelayProofs, "proof" | "refused"> | undefined;
  /**
   * How many sockets the session opens in parallel. It keeps the one with the shortest `ping` round trip to the host's
   * Room and closes the others before anything is sent on them, so a client whose ISP reaches the relay's anycast at a
   * far colo on some connections gets a near one when any dial lands there (#1351). Default {@link RELAY_BEST_OF}, or 1
   * for a relay on loopback or an IP literal; pairing sessions and proven dials (`proofs`) always open one, because
   * the relay charges each upgrade of those to a per-slot or per-key budget.
   */
  readonly bestOf?: number | undefined;
}

export const RELAY_BEST_OF = 3;
/** How long after the first socket's answer a slower-opening socket may still beat it. */
export const RELAY_BEST_OF_GRACE_MS = 150;
/**
 * Where a best-of-N dial's second and third sockets go when the relay is on the default HTTPS port: other ports its edge
 * serves the same HTTPS on (Cloudflare proxies 8443 and 2053 as it does 443). A browser holds back a WebSocket handshake
 * while another to the same address and port is still connecting (RFC 6455 section 4.1), so three sockets to one port
 * open one after another and the later ones miss the race; on distinct ports they open together (#1418). A relay on an
 * explicit port keeps it for every socket.
 */
export const RELAY_BEST_OF_PORTS: readonly string[] = ["8443", "2053"];
/** A socket whose `ping` the Room has not answered within this is kept only if no other socket was answered. */
export const RELAY_PROBE_TIMEOUT_MS = 1_500;

/** How long a client session's socket has to open, in step with the 10 s the handshakes after it allow. */
export const RELAY_CONNECT_TIMEOUT_MS = 10_000;

function cancelledBy(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("the relay session was cancelled");
}

/** A relay reached by loopback or an address literal is one route: there is no other ingress for a second socket to find. */
function isSingleRoute(relayUrl: string): boolean {
  if (!URL.canParse(relayUrl)) return true;
  const { hostname } = new URL(relayUrl);
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.startsWith("[") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
  );
}

function socketCount(options: ClientConnectOptions): number {
  if (options.pairSlot !== undefined || options.proofs !== undefined) return 1;
  const count = options.bestOf ?? (isSingleRoute(options.relayUrl) ? 1 : RELAY_BEST_OF);
  return Math.max(1, Math.floor(count));
}

/**
 * Opens a client session to a host through the relay. Resolves once the socket is open, or, with several sockets (see
 * {@link ClientConnectOptions.bestOf}), once the one nearest the Room is chosen; refusals (4404 host offline, 4429 rate
 * limited) arrive afterwards as the link's close, with the code on the RelayCloseError.
 */
export async function connectRelayClient(options: ClientConnectOptions): Promise<WebSocketLink> {
  const { hostId, pairSlot } = options;
  if (!HOST_ID_PATTERN.test(hostId)) throw new Error(`invalid hostId ${hostId}`);
  if (pairSlot !== undefined && !PAIR_SLOT_PATTERN.test(pairSlot)) throw new Error(`invalid pairing slot ${pairSlot}`);
  const { signal } = options;
  if (signal?.aborted === true) throw cancelledBy(signal);
  const count = socketCount(options);
  if (count === 1) return openSocket(options).opened;
  const entrants = Array.from({ length: count }, (_, index) => {
    const { ws, opened } = openSocket(options, index);
    return {
      opened,
      roundTrip: () => roomRoundTrip(ws, RELAY_PROBE_TIMEOUT_MS),
      discard: (link: WebSocketLink) => link.close(),
    };
  });
  return raceFastest(entrants, { graceMs: RELAY_BEST_OF_GRACE_MS, signal });
}

/** The relay URL a best-of-N dial's `index`th socket dials: see {@link RELAY_BEST_OF_PORTS}. */
function socketRelayUrl(relayUrl: string, index: number): string {
  const port = RELAY_BEST_OF_PORTS[index - 1];
  if (port === undefined) return relayUrl;
  const url = new URL(relaySocketUrl(relayUrl, "/"));
  if (url.protocol !== "wss:" || url.port !== "") return relayUrl;
  url.port = port;
  return url.toString();
}

/** One client socket: `opened` resolves with its link once it is open. */
function openSocket(
  options: ClientConnectOptions,
  index = 0,
): {
  readonly ws: WebSocket;
  readonly opened: Promise<WebSocketLink>;
} {
  const { hostId, pairSlot, signal } = options;
  const relayUrl = socketRelayUrl(options.relayUrl, index);
  const query = new URLSearchParams(pairSlot === undefined ? [] : [["pair", pairSlot]]);
  query.set(...CREDIT_QUERY);
  const relayOrigin = relayOriginOf(relaySocketUrl(options.relayUrl, "/"));
  const proof = options.proofs?.proof("client", hostId, relayOrigin);
  if (proof !== undefined) query.set(PROOF_QUERY, proof);
  const url = relaySocketUrl(relayUrl, `/v1/client/${hostId}?${query.toString()}`);
  const ws = (options.createSocket ?? defaultCreateSocket)(url);
  const link = new WebSocketLink(ws, options.pingIntervalMs ?? PING_INTERVAL_MS, { credit: true });
  if (proof !== undefined) {
    link.onClose((error) => {
      if (error instanceof RelayCloseError && error.code === CloseCode.PassRefused)
        options.proofs?.refused(relayOrigin, proof);
    });
  }
  // The URL may carry a proof: errors (and so logs) name the path only.
  const path = relaySocketUrl(relayUrl, `/v1/client/${hostId}`);
  const timeoutMs = options.timeoutMs ?? RELAY_CONNECT_TIMEOUT_MS;
  const opened = new Promise<WebSocketLink>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    function settle(): boolean {
      if (settled) return false;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      return true;
    }
    function fail(error: Error): void {
      if (!settle()) return;
      if (ws.readyState === WebSocket.CONNECTING) ws.close();
      link.close();
      reject(error);
    }
    function onAbort(): void {
      if (signal !== undefined) fail(cancelledBy(signal));
    }
    timer = setTimeout(() => fail(new Error(`relay socket to ${path} did not open within ${timeoutMs} ms`)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    ws.addEventListener(
      "open",
      () => {
        if (settle()) resolve(link);
      },
      { once: true },
    );
    link.onClose((error) => {
      if (!settle()) return;
      reject(error ?? new Error(`relay socket to ${path} closed before opening`));
    });
  });
  return { ws, opened };
}
