import { base64urlEncode, CloseCode, isResumeRequest, type SecureLink, SessionKind } from "@doriface/crypto";
import { requireWithin } from "@doriface/policy";
import type { WebSocketHandler } from "bun";
import { type Context, Hono, type Next } from "hono";
import { type BunWebSocketData, upgradeWebSocket } from "hono/bun";
import type { WSEvents } from "hono/ws";
import { attachAfterRun } from "./attach-after-run.ts";
import { checkBearer, checkHandshake } from "./auth.ts";
import { bridge } from "./bridge.ts";
import { AmbiguousDeviceError, type DeviceSurface, UnknownDeviceError } from "./device-surface.ts";
import { acceptE2ee, type E2eeDeps, type E2eeTransport } from "./e2ee/accept.ts";
import { meshPeer } from "./e2ee/authorize.ts";
import { firstLineRefusal, gateHello } from "./e2ee/first-line.ts";
import { type E2eeWire, plaintextLink, WsByteLink } from "./e2ee/links.ts";
import { helloOnly } from "./e2ee/pairing-session.ts";
import { PeekedWire } from "./e2ee/peeked-wire.ts";
import { ResumableSessions } from "./e2ee/resumes.ts";
import { type SpeculativeHello, withoutFirstLine } from "./e2ee/speculative-hello.ts";
import type { LiveSessions } from "./e2ee/sessions.ts";
import type { Link } from "./link.ts";
import type { AuthorizeIndex } from "./mesh/authorize-index.ts";
import type { PairingOfferView } from "./pair-offer.ts";
import type { PushLink } from "./push/push-stream.ts";
import { LOOPBACK_OWNER } from "./push/subscriptions.ts";
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
  readonly e2ee?:
    | (E2eeDeps & {
        readonly sessions: LiveSessions;
        readonly meshStream?: MeshStreamHandler;
        readonly rosterStream?: MeshStreamHandler;
        /** Every authenticated session, so a member's hc line counts as its presence (section 8.2). */
        readonly meshPresence?: MeshStreamHandler;
      })
    | undefined;
  /** Answers an early hello before key confirmation, within its own budget (#1271); absent, every hello waits. */
  readonly speculative?: Pick<SpeculativeHello, "answer" | "settle"> | undefined;
  /** For tests: the direct-path idle close (default {@link DIRECT_IDLE_MS}). */
  readonly directIdleMs?: number | undefined;
  /** For tests: how long a detached hc session waits for its client's resume (default RESUME_GRACE_MS). */
  readonly resumeGraceMs?: number | undefined;
  /** Serves a device's push stream (`stream:"push"`, and `/v1/push` on loopback); without it both are refused. */
  readonly push?: ((link: PushLink, owner: string) => void) | undefined;
  /**
   * This computer's own pairing offer, for the app that runs the host: `POST /v1/pair` opens one and `GET /v1/pair`
   * reports it, behind the same token as `/v1/hc` and never on the LAN listener. Without it both routes are absent.
   */
  readonly pair?: PairRoute | undefined;
  /**
   * This computer's paired devices for the app that runs the host: `GET /v1/devices` lists them and
   * `DELETE /v1/devices/<id>` revokes one, behind the same token as `/v1/hc` and never on the LAN listener. Without it
   * both routes are absent.
   */
  readonly devices?: DeviceSurface | undefined;
}

/** The loopback pairing routes' answers; the app renders these, so they stay JSON-serialisable. */
export interface PairRoute {
  open(): Promise<PairAnswer>;
  state(): PairAnswer;
}

export type PairAnswer =
  | { readonly state: "pending"; readonly offer: PairingOfferView }
  | {
      readonly state: "paired";
      readonly device: { readonly name: string; readonly id: string; readonly pairedAt: string } | null;
    }
  | { readonly state: "expired" }
  | { readonly state: "none" };

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
  const pushEvents = new WeakSet<WSEvents>();
  const { log, e2ee } = options;
  const resumes = new ResumableSessions(log, options.resumeGraceMs);

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
  const tokenGate = async (c: Context, next: Next) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.text("websocket upgrade required", 426);
    const verdict = checkHandshake(c.req.header("sec-websocket-protocol"), options.token);
    if (!verdict.ok) return c.text(verdict.reason, verdict.status);
    await next();
    return undefined;
  };
  // A fresh events object per upgrade identifies the connection in the Bun handler below.
  app.get(
    "/v1/hc",
    tokenGate,
    upgradeWebSocket(() => ({})),
  );
  // The loopback client's push stream, behind the same token as its hc stream.
  app.get(
    "/v1/push",
    tokenGate,
    upgradeWebSocket(() => {
      const events: WSEvents = {};
      pushEvents.add(events);
      return events;
    }),
  );
  const pair = options.pair;
  const devices = options.devices;
  if (pair !== undefined || devices !== undefined) {
    const pairGate = async (c: Context, next: Next) => {
      if (!checkBearer(c.req.header("authorization"), options.token))
        return c.text("missing or wrong doriface token", 401);
      await next();
      return undefined;
    };
    if (pair !== undefined) {
      app.get("/v1/pair", pairGate, (c) => c.json(pair.state()));
      app.post("/v1/pair", pairGate, async (c) => c.json(await pair.open()));
    }
    if (devices !== undefined) {
      app.get("/v1/devices", pairGate, (c) => c.json({ devices: devices.list() }));
      app.delete("/v1/devices/:id", pairGate, async (c) => {
        try {
          return c.json({ revoked: await devices.revoke(c.req.param("id") ?? "") });
        } catch (error) {
          if (error instanceof UnknownDeviceError) return c.json({ error: error.message }, 404);
          if (error instanceof AmbiguousDeviceError) return c.json({ error: error.message }, 409);
          throw error instanceof Error ? error : new Error(String(error));
        }
      });
    }
  }

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
    void bridge(link, attachAfterRun(pipe), (error) => log(`connection closed: ${String(error)}`));
  };

  const serveE2ee = async (raw: E2eeWire, transport: E2eeTransport): Promise<void> => {
    if (e2ee === undefined) throw new Error("end-to-end encryption needs a state dir");
    // The first message says which this is: a client coming back to a session it still holds (contract v1.11), or a
    // handshake for a new one. A resume is answered from the session it names; anything else runs the handshake.
    const wire = new PeekedWire(raw);
    let first: Uint8Array;
    try {
      first = await wire.first;
    } catch {
      return;
    }
    if (isResumeRequest(first)) {
      const allows = (session: SecureLink): boolean => e2ee.sessions.allows(session);
      if (!resumes.accept(wire, first, wire.drain(), allows))
        wire.close(CloseCode.ResumeRefused, "cannot resume this session");
      return;
    }
    const secure = await acceptE2ee(wire, { ...e2ee, speculative: options.speculative }, transport);
    if (secure === undefined) return;
    e2ee.meshPresence?.(secure);
    if (secure.stream === "mesh") return serveMesh(secure);
    if (secure.stream === "roster") {
      if (e2ee.rosterStream === undefined) secure.close(1000, "this host serves no roster stream");
      else e2ee.rosterStream(secure);
      return;
    }
    if (secure.stream === "push") return servePush(secure);
    // A pairing session is not gated by authorize's session limit, yet the new device keeps it as its workspace.
    const room =
      secure.kind === SessionKind.Session ? undefined : requireWithin(e2ee.policy, "sessions", e2ee.sessions.count());
    if (!e2ee.sessions.admitHc(secure, e2ee.policy)) return;
    const gate = hcGateFor(base64urlEncode(secure.remoteStatic), (code, reason) => secure.close(code, reason));
    if (gate === undefined) return;
    e2ee.mesh?.recordClientSession(base64urlEncode(secure.remoteStatic));
    // An hc session outlives its socket: a client whose link drops comes back to it instead of attaching anew.
    resumes.register(secure);
    const link = gate(plaintextLink(secure, wire));
    const answered = options.speculative?.settle(secure) === "answered";
    const hc = e2ee.sessions.guardHc(secure, answered ? withoutFirstLine(link) : link);
    const close = (code: number, reason: string): void => secure.close(code, reason);
    if (room === undefined || room.allowed) return pipeTo(hc, close);
    log(`plan: a pairing session ends after its hello: ${room.message}`);
    pipeTo(
      helloOnly(hc, () => close(CloseCode.RateLimited, room.message)),
      close,
    );
  };

  /** A join is no member's session yet, so only a member's sync session is registered for revocation. */
  const serveMesh = (secure: SecureLink): void => {
    if (e2ee === undefined) return;
    if (secure.kind === SessionKind.Session) e2ee.sessions.add(secure);
    if (e2ee.meshStream === undefined) secure.close(1000, "this host serves no mesh stream");
    else e2ee.meshStream(secure);
  };

  /** A device's push stream: registered so a revoke closes it, then served as that device's key. */
  const servePush = (secure: SecureLink): void => {
    if (e2ee === undefined || !e2ee.sessions.add(secure)) return;
    if (options.push === undefined) secure.close(1011, "this host sends no push notices");
    else {
      const key = base64urlEncode(secure.remoteStatic);
      e2ee.mesh?.recordClientSession(key);
      options.push(e2ee.sessions.guardPush(secure), key);
    }
  };

  /**
   * Section 7.6: the gate for a session's hc lines, whose hellos may announce only a member's own `core.id`, and
   * never a member's on a device session. The same gate on every transport: a client of this computer over the plain
   * loopback socket (`key` undefined) is a device here too, so the transport grants nothing a paired device is not
   * granted. Undefined when the mesh state cannot be read: the session is closed 1011 before its plaintext is read, so
   * nothing of it reaches an `hc connect`, and none is started.
   */
  const hcGateFor = (
    key: string | undefined,
    close: (code: number, reason: string) => void,
  ): ((link: Link) => Link) | undefined => {
    let index: AuthorizeIndex | undefined;
    try {
      index = e2ee?.mesh?.authorizeIndex();
    } catch (error) {
      log(`cannot read the mesh state: ${String(error)}`);
      close(1011, "cannot read the mesh state");
      return undefined;
    }
    const peer = (key === undefined ? undefined : meshPeer(index, key)) ?? { kind: "device" as const };
    return (link) =>
      gateHello(
        link,
        (coreId) => firstLineRefusal(peer, coreId, index),
        (code, reason) => {
          log(`e2ee: close code=${code} source=hc-hello peer=${peer.kind} stream=hc: ${reason}`);
          close(code, reason);
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
      if (pushEvents.has(ws.data.events)) {
        if (options.push === undefined) link.close(1011, "this host sends no push notices");
        else options.push(link, LOOPBACK_OWNER);
        return;
      }
      if (direct) {
        serveE2ee(new WsByteLink(link), { kind: "lan" }).catch((error: unknown) => {
          log(`e2ee session failed: ${String(error)}`);
          link.close(1011, "internal error");
        });
        return;
      }
      const close = (code: number, reason: string): void => link.close(code, reason);
      const gate = hcGateFor(undefined, close);
      if (gate === undefined) return;
      pipeTo(gate(link), close);
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
    // A session kept for a resume has no socket to close; its hc connect would otherwise outlive the host by the window.
    resumes.closeDetached(1001, "host shutting down");
    await Promise.all(children);
  };

  return { app, lanApp, websocket, serveE2ee, closeAll };
}
