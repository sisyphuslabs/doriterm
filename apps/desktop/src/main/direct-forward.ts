import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { forwardedTarget } from "../config/direct-target.ts";

/** How much one direction may queue before the forward closes instead of growing: both sides close with 1009. */
export const FORWARD_QUEUE_BYTES = 1024 * 1024;
/** The largest frame forwarded; hc's own frames are far smaller, so a larger one is not ours to carry. */
export const FORWARD_FRAME_BYTES = 16 * 1024 * 1024;
const CLOSE_OVERFLOW = 1009;
/**
 * The only text frames carried: the direct path's keepalive. The page pings and the host answers; without it the host
 * closes a session that went quiet, and the page reattaches (#1040).
 */
const PAGE_TEXT = "ping";
const HOST_TEXT = "pong";

/** One rendered page's socket to the host: a capability names one target, for one window, once. */
interface Capability {
  readonly windowId: number;
  readonly target: string;
  used: boolean;
}

export type DirectForwardAnswer = { readonly url: string } | { readonly refused: string };

export interface DirectForwarderDeps {
  /** The only origin a forward is taken from: the app's own page. */
  readonly origin: string;
  /** For tests: the outbound socket. */
  readonly dial?: ((target: string) => WebSocket) | undefined;
  /** For tests: the capability's bytes. */
  readonly capability?: (() => string) | undefined;
}

const capabilityOf = (): string => randomBytes(16).toString("base64url");

const sendTo = (socket: WebSocket, frame: Buffer | string): void =>
  typeof frame === "string" ? socket.send(frame) : socket.send(frame, { binary: true });

/**
 * The byte forwarder behind #449: a page on the app origin asks for one capability, then dials
 * `ws://127.0.0.1:<port>/<capability>`; the shell opens the configured direct address and copies frames between them.
 * It never terminates, decrypts or inspects them: Noise runs end to end in the page, so the shell carries ciphertext.
 */
export class DirectForwarder {
  readonly #deps: DirectForwarderDeps;
  readonly #capabilities = new Map<string, Capability>();
  readonly #live = new Map<number, Set<() => void>>();
  #server: Server | undefined;
  /** The listener being bound, shared by every request that arrives meanwhile so they all get the one port. */
  #listening: Promise<number> | undefined;
  #port = 0;

  constructor(deps: DirectForwarderDeps) {
    this.#deps = deps;
  }

  /**
   * Issues one capability to `windowId` for the Direct address `value`, checked here: the URL the page dials, or why it
   * may not forward. Each capability carries its own target, so every mesh member's race reaches its own address and a
   * forward to one member never closes or redirects another's (#1499).
   */
  async issue(windowId: number, value: string): Promise<DirectForwardAnswer> {
    const target = forwardedTarget(value);
    if (target === undefined) return { refused: "no direct address to forward to" };
    const port = await this.#listen();
    const capability = (this.#deps.capability ?? capabilityOf)();
    this.#capabilities.set(capability, { windowId, target, used: false });
    return { url: `ws://127.0.0.1:${port}/${capability}` };
  }

  /** Forgets a capability the page gave up on, so a late upgrade is refused instead of opening a socket. */
  cancel(url: string): boolean {
    const capability = url.slice(url.lastIndexOf("/") + 1);
    return this.#capabilities.delete(capability);
  }

  /** A window that reloaded, navigated away or closed keeps no capability and no socket. */
  dropWindow(windowId: number): void {
    for (const [capability, entry] of this.#capabilities)
      if (entry.windowId === windowId) this.#capabilities.delete(capability);
    for (const close of this.#live.get(windowId) ?? []) close();
    this.#live.delete(windowId);
  }

  /** Every window's forward, on quit. */
  dropAll(): void {
    this.#capabilities.clear();
    for (const closes of this.#live.values()) for (const close of closes) close();
    this.#live.clear();
  }

  async stop(): Promise<void> {
    this.dropAll();
    const server = this.#server;
    this.#server = undefined;
    this.#listening = undefined;
    this.#port = 0;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * One listener for every capability. Members ask at once (#1499): a second request arriving while the first was still
   * binding made a second server, whose port replaced the first's and so refused the first member's Host header.
   */
  #listen(): Promise<number> {
    this.#listening ??= this.#bind().catch((error: unknown) => {
      this.#listening = undefined;
      throw error;
    });
    return this.#listening;
  }

  async #bind(): Promise<number> {
    const server = createServer((_request: IncomingMessage, response) => {
      response.writeHead(404, { "content-type": "text/plain" }).end("not a forwarder route");
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: FORWARD_FRAME_BYTES });
    server.on("upgrade", (request, socket, head) => this.#upgrade(request, socket, head, wss));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    this.#server = server;
    this.#port = typeof address === "object" && address !== null ? address.port : 0;
    return this.#port;
  }

  #refuse(socket: Duplex, status: number, reason: string): void {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    socket.destroy();
  }

  /** Every check that must pass before an outbound socket is opened: path, Host, Origin, and an unused capability. */
  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): void {
    const host = request.headers.host ?? "";
    if (host !== `127.0.0.1:${this.#port}`) return this.#refuse(socket, 403, "refused host");
    if ((request.headers.origin ?? "") !== this.#deps.origin) return this.#refuse(socket, 403, "refused origin");
    const path = request.url ?? "";
    const capability = path.startsWith("/") ? path.slice(1) : "";
    const entry = this.#capabilities.get(capability);
    if (entry === undefined || entry.used) return this.#refuse(socket, 403, "refused capability");
    entry.used = true;
    const target = entry.target;
    wss.handleUpgrade(request, socket, head, (page) => this.#bridge(entry.windowId, target, page));
  }

  /** Copies frames both ways until either side closes; the size limits are the only thing it reads. */
  #bridge(windowId: number, target: string, page: WebSocket): void {
    const outbound = (this.#deps.dial ?? ((url: string) => new WebSocket(url)))(target);
    let closed = false;
    let heldBytes = 0;
    // Frames the page sends while the target is still connecting: the page's first handshake message is one of them.
    const held: (Buffer | typeof PAGE_TEXT)[] = [];
    const close = (): void => {
      if (closed) return;
      closed = true;
      held.length = 0;
      page.close();
      outbound.close();
      this.#live.get(windowId)?.delete(close);
    };
    const overflow = (): void => {
      page.close(CLOSE_OVERFLOW, "too much queued");
      outbound.close(CLOSE_OVERFLOW, "too much queued");
      close();
    };
    const closes = this.#live.get(windowId) ?? new Set<() => void>();
    closes.add(close);
    this.#live.set(windowId, closes);

    page.on("message", (data: Buffer, binary: boolean) => {
      if (!binary && String(data) !== PAGE_TEXT) return close();
      const frame = binary ? data : PAGE_TEXT;
      if (outbound.readyState === WebSocket.CONNECTING) {
        heldBytes += data.byteLength;
        if (heldBytes > FORWARD_QUEUE_BYTES) return overflow();
        held.push(frame);
        return undefined;
      }
      if (outbound.readyState !== WebSocket.OPEN) return close();
      if (outbound.bufferedAmount > FORWARD_QUEUE_BYTES) return overflow();
      sendTo(outbound, frame);
    });
    outbound.on("open", () => {
      for (const frame of held.splice(0)) sendTo(outbound, frame);
      heldBytes = 0;
    });
    outbound.on("message", (data: Buffer, binary: boolean) => {
      if (!binary && String(data) !== HOST_TEXT) return close();
      if (page.bufferedAmount > FORWARD_QUEUE_BYTES) return overflow();
      if (page.readyState === WebSocket.OPEN) sendTo(page, binary ? data : HOST_TEXT);
    });
    page.on("close", close);
    outbound.on("close", close);
    page.on("error", close);
    outbound.on("error", close);
  }
}
