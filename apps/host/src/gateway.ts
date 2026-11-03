import { base64urlEncode, type SecureLink, SessionKind } from "@doriface/crypto";
import type { WebSocketHandler } from "bun";
import { Hono } from "hono";
import { type BunWebSocketData, upgradeWebSocket } from "hono/bun";
import type { WSEvents } from "hono/ws";
import { checkHandshake } from "./auth.ts";
import { bridge } from "./bridge.ts";
import { acceptE2ee, type E2eeDeps, type E2eeTransport } from "./e2ee/accept.ts";
import { meshPeer } from "./e2ee/authorize.ts";
import { firstLineRefusal, gateHello } from "./e2ee/first-line.ts";
import { type E2eeWire, plaintextLink, WsByteLink } from "./e2ee/links.ts";
import type { LiveSessions } from "./e2ee/sessions.ts";
import type { Link } from "./link.ts";
import type { AuthorizeIndex } from "./mesh/authorize-index.ts";
import { DIRECT_IDLE_MS, WsLink } from "./ws-link.ts";

/** A link backed by a child process; `exited` settles once the child is gone. */
export type ChildLink = Link & { readonly exited: Promise<unknown> };

export interface GatewayOptions {
  readonly token: string;
  readonly hostVersion: string;
  readonly hcVersion: string;
  readonly openPipe: () => ChildLink;
  readonly log: (line: string) => void;
  /** Enables `/v1/e2ee`: the Noise record layer in front of the same `hc connect` pipe. */
  readonly e2ee?: (E2eeDeps & { readonly sessions: LiveSessions; readonly meshStream?: MeshStreamHandler }) | undefined;
  /** For tests: the direct-path idle close (default {@link DIRECT_IDLE_MS}). */
  readonly directIdleMs?: number | undefined;
}

/** Serves a session whose plaintext is the mesh stream (a member's sync session, or a machine join). */
export type MeshStreamHandler = (secure: SecureLink) => void;

export interface Gateway {
  /** Every route: healthz, the loopback-only plaintext `/v1/hc`, and `/v1/e2ee` when enabled. */
  readonly app: Hono;
  /** For a non-loopback listener: healthz and `/v1/e2ee` only, since every byte there is authenticated. */
  readonly lanApp: Hono;
  readonly websocket: WebSocketHandler<BunWebSocketData>;
  /**
   * Runs the responder handshake on `wire` and pipes the decrypted session to its own `hc connect`, as `/v1/e2ee`
   * does; relay sessions come in here. Resolves once the session is piped or refused.
   */
  serveE2ee(wire: E2eeWire, transport: E2eeTransport): Promise<void>;
  /** Closes every client socket and resolves once every `hc connect` child has exited. */
  closeAll(): Promise<void>;
}

export function createGateway(options: GatewayOptions): Gateway {
  const links = new WeakMap<WSEvents, WsLink<BunWebSocketData>>();
  const sockets = new Set<WsLink<BunWebSocketData>>();
  const children = new Set<Promise<unknown>>();
  const e2eeEvents = new WeakSet<WSEvents>();
  const { log, e2ee } = options;

  const app = new Hono();
  const lanApp = new Hono();
  for (const target of [app, lanApp]) {
    target.get("/healthz", (c) => c.json({ ok: true, hostVersion: options.hostVersion, hcVersion: options.hcVersion }));
    if (e2ee === undefined) continue;
    target.get(
      "/v1/e2ee",
      async (c, next) => {
        if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.text("websocket upgrade required", 426);
        await next();
        return undefined;
      },
      upgradeWebSocket(() => {
        const events: WSEvents = {};
        e2eeEvents.add(events);
        return events;
      }),
    );
  }
  app.get(
    "/v1/hc",
    async (c, next) => {
      if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.text("websocket upgrade required", 426);
      const verdict = checkHandshake(c.req.header("sec-websocket-protocol"), options.token);
      if (!verdict.ok) return c.text(verdict.reason, verdict.status);
      await next();
      return undefined;
    },
    // A fresh events object per upgrade identifies the connection in the Bun handler below.
    upgradeWebSocket(() => ({})),
  );

  const pipeTo = (link: Link, closeClient: (code: number, reason: string) => void): void => {
    let pipe: ChildLink;
    try {
      pipe = options.openPipe();
    } catch (error) {
      log(`cannot start hc connect: ${String(error)}`);
      closeClient(1011, "hc connect failed to start");
      return;
    }
    const exited = pipe.exited.finally(() => children.delete(exited));
    children.add(exited);
    void bridge(link, pipe, (error) => log(`connection closed: ${String(error)}`));
  };

  const serveE2ee = async (wire: E2eeWire, transport: E2eeTransport): Promise<void> => {
    if (e2ee === undefined) throw new Error("end-to-end encryption needs a state dir");
    const secure = await acceptE2ee(wire, e2ee, transport);
    if (secure === undefined) return;
    if (secure.stream === "mesh") return serveMesh(secure);
    e2ee.sessions.add(secure);
    const gate = hcGate(secure);
    if (gate === undefined) return;
    pipeTo(gate(plaintextLink(secure, wire)), (code, reason) => secure.close(code, reason));
  };

  /** A join is no member's session yet, so only a member's sync session is registered for revocation. */
  const serveMesh = (secure: SecureLink): void => {
    if (e2ee === undefined) return;
    if (secure.kind === SessionKind.Session) e2ee.sessions.add(secure);
    if (e2ee.meshStream === undefined) secure.close(1000, "this host serves no mesh stream");
    else e2ee.meshStream(secure);
  };

  /**
   * Section 7.6: the gate for a session's hc lines, whose hellos may announce only a member's own `core.id`, and
   * never a member's on a device session. Undefined when the mesh state cannot be read: the session is closed 1011
   * before its plaintext is read, so nothing of it reaches an `hc connect`, and none is started.
   */
  const hcGate = (secure: SecureLink): ((link: Link) => Link) | undefined => {
    let index: AuthorizeIndex | undefined;
    try {
      index = e2ee?.mesh?.authorizeIndex();
    } catch (error) {
      log(`cannot read the mesh state: ${String(error)}`);
      secure.close(1011, "cannot read the mesh state");
      return undefined;
    }
    const peer = meshPeer(index, base64urlEncode(secure.remoteStatic)) ?? { kind: "device" as const };
    return (link) =>
      gateHello(
        link,
        (coreId) => firstLineRefusal(peer, coreId, index),
        (code, reason) => {
          log(`mesh: closing a session: ${reason}`);
          secure.close(code, reason);
        },
      );
  };

  const websocket: WebSocketHandler<BunWebSocketData> = {
    perMessageDeflate: false,
    open(ws) {
      const direct = e2ee !== undefined && e2eeEvents.has(ws.data.events);
      const link = new WsLink(ws, { keepaliveIdleMs: direct ? (options.directIdleMs ?? DIRECT_IDLE_MS) : undefined });
      links.set(ws.data.events, link);
      sockets.add(link);
      link.onClose(() => sockets.delete(link));
      if (direct) {
        serveE2ee(new WsByteLink(link), { kind: "lan" }).catch((error: unknown) => {
          log(`e2ee session failed: ${String(error)}`);
          link.close(1011, "internal error");
        });
        return;
      }
      pipeTo(link, (code, reason) => link.close(code, reason));
    },
    message(ws, message) {
      links.get(ws.data.events)?.receive(message);
    },
    drain(ws) {
      links.get(ws.data.events)?.drained();
    },
    close(ws) {
      links.get(ws.data.events)?.peerClosed();
    },
  };

  const closeAll = async (): Promise<void> => {
    for (const link of sockets) link.close(1001, "host shutting down");
    await Promise.all(children);
  };

  return { app, lanApp, websocket, serveE2ee, closeAll };
}
