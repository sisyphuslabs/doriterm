import type { SecureLink } from "@doriface/crypto";
import type { WebSocketHandler } from "bun";
import type { Hono } from "hono";
import type { BunWebSocketData } from "hono/bun";
import type { DeviceSurface } from "./device-surface.ts";
import type { E2eeDeps, E2eeTransport } from "./e2ee/accept.ts";
import type { E2eeWire } from "./e2ee/links.ts";
import type { LiveSessions } from "./e2ee/sessions.ts";
import type { SpeculativeHello } from "./e2ee/speculative-hello.ts";
import type { Link } from "./link.ts";
import type { McpSurface } from "./mcp-surface.ts";
import type { PairRoute } from "./owner-routes.ts";
import type { PushLink } from "./push/push-stream.ts";
import type { RunTokens } from "./resume/run-tokens.ts";

/** A link backed by a child process; `exited` settles once the child is gone. */
export type ChildLink = Link & { readonly exited: Promise<unknown> };

export interface GatewayOptions {
  readonly token: string;
  readonly hostVersion: string;
  readonly hcVersion: string;
  readonly openPipe: () => ChildLink;
  /** The OSC 7577 token hook each client connection's runs go through; unset while program resume is off. */
  readonly runTokens?: (() => RunTokens) | undefined;
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
  /** Serves the discovery-only MCP stream under the client's key. */
  readonly mcp?: ((link: PushLink, key: string) => void) | undefined;
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
  /**
   * This computer's MCP switch for the app that runs the host: `GET /v1/mcp` reads it with the connected clients and
   * `PUT /v1/mcp` with `{"enabled": true|false}` sets it, behind the same token and never on the LAN listener.
   */
  readonly mcpSurface?: McpSurface | undefined;
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
