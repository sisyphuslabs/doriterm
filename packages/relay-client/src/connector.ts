import { RelayCloseError } from "./link.ts";
import type { RelayProofs } from "./pass-book.ts";
import { type CreateSocket, defaultCreateSocket, relaySocketUrl } from "./socket.ts";
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
  /** A host's relay passes (contract v1.6): the session carries a proof when one is available. */
  readonly proofs?: Pick<RelayProofs, "proof" | "refused"> | undefined;
}

/**
 * Opens a client session to a host through the relay. Resolves once the socket is open; refusals (4404 host
 * offline, 4429 rate limited) arrive afterwards as the link's close, with the code on the RelayCloseError.
 */
export async function connectRelayClient(options: ClientConnectOptions): Promise<WebSocketLink> {
  const { hostId, pairSlot } = options;
  if (!HOST_ID_PATTERN.test(hostId)) throw new Error(`invalid hostId ${hostId}`);
  if (pairSlot !== undefined && !PAIR_SLOT_PATTERN.test(pairSlot)) throw new Error(`invalid pairing slot ${pairSlot}`);
  const query = new URLSearchParams(pairSlot === undefined ? [] : [["pair", pairSlot]]);
  query.set(...CREDIT_QUERY);
  const relayOrigin = relayOriginOf(relaySocketUrl(options.relayUrl, "/"));
  const proof = options.proofs?.proof("client", hostId, relayOrigin);
  if (proof !== undefined) query.set(PROOF_QUERY, proof);
  const url = relaySocketUrl(options.relayUrl, `/v1/client/${hostId}?${query.toString()}`);
  const ws = (options.createSocket ?? defaultCreateSocket)(url);
  const link = new WebSocketLink(ws, options.pingIntervalMs ?? PING_INTERVAL_MS, { credit: true });
  if (proof !== undefined) {
    link.onClose((error) => {
      if (error instanceof RelayCloseError && error.code === CloseCode.PassRefused)
        options.proofs?.refused(relayOrigin);
    });
  }
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(link), { once: true });
    link.onClose((error) => reject(error ?? new Error(`relay socket to ${url} closed before opening`)));
  });
}
