import { PING, PONG, sendableCloseCode } from "./wire/index.ts";

/** Creates the WebSocket for a relay URL; injectable so tests and other runtimes can supply their own. */
export type CreateSocket = (url: string) => WebSocket;

export const defaultCreateSocket: CreateSocket = (url) => new WebSocket(url);

const OPEN = 1;

export function isOpen(ws: WebSocket): boolean {
  return ws.readyState === OPEN;
}

/**
 * Closes with `code` if a WebSocket client may send it (1000 or 3000-4999), else with 1000; browsers throw for
 * the other codes. The local side still reports the real code.
 */
export function closeSocket(ws: WebSocket, code: number, reason: string): void {
  ws.close(sendableCloseCode(code), reason);
}

/** `https://relay.example` + `/v1/host/<id>` -> `wss://relay.example/v1/host/<id>`. */
export function relaySocketUrl(relayUrl: string, path: string): string {
  if (!URL.canParse(relayUrl)) throw new Error(`relay URL must be http(s) or ws(s): ${relayUrl}`);
  const url = new URL(path, relayUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "wss:" && url.protocol !== "ws:")
    throw new Error(`relay URL must be http(s) or ws(s): ${relayUrl}`);
  return url.toString();
}

/**
 * Times one `ping` -> `pong` on an open relay socket, in ms. The relay answers `ping` itself (contract: Relay text
 * messages), so this is the client's way to the host's Room and back. `Infinity` when the socket closed or no `pong`
 * came within `timeoutMs`.
 */
export function roomRoundTrip(ws: WebSocket, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const start = performance.now();
    const done = (ms: number): void => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      resolve(ms);
    };
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.data === PONG) done(performance.now() - start);
    };
    const onClose = (): void => done(Number.POSITIVE_INFINITY);
    const timer = setTimeout(onClose, timeoutMs);
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    if (isOpen(ws)) ws.send(PING);
    else onClose();
  });
}
