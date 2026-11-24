import type { JsonWebKey } from "node:crypto";
import { isJsonObject } from "@doriface/protocol";
import type { PushLink } from "../push/push-stream.ts";
import { calledTool, requestScope, SCOPES } from "./scope.ts";
import { TokenRefused, verifyAccessToken } from "./token.ts";

const VERSION = "2026-07-28";
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const STREAMED: ReadonlySet<string> = new Set(["subscriptions/listen", "events/stream"]);

/** One audited call: who, what and whether it worked; never its arguments or output. */
export interface AuditLine {
  readonly at: number;
  readonly agent: string;
  readonly method: string;
  readonly tool: string | null;
  readonly ok: boolean;
}

export interface HostedDeps {
  /** This host's MCP endpoint URL, the audience its tokens must name. */
  readonly resource: string;
  readonly issuer: string;
  readonly keys: () => readonly (JsonWebKey & { readonly kid?: string })[];
  /** An agent the person approved in the app, with the scopes they gave it; undefined once revoked. */
  readonly agents: (id: string) => { readonly name: string; readonly scopes: readonly string[] } | undefined;
  readonly allowedOrigins: readonly string[];
  readonly perMinute: number;
  readonly now: () => number;
  readonly audit: (line: AuditLine) => void;
  /** Serves one MCP session on a link, as a paired device's stream is served. */
  readonly serve: (link: PushLink) => void;
}

const json = (status: number, body: object, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers });
const rpcError = (status: number, id: unknown, code: number, message: string): Response =>
  json(status, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const decodeHeader = (value: string | null): string | null => {
  const sentinel = value?.match(/^=\?base64\?(.*)\?=$/);
  return sentinel?.[1] === undefined ? value : Buffer.from(sentinel[1], "base64").toString("utf8");
};

/** The Streamable HTTP MCP endpoint (revision 2026-07-28) for agents that reach this host by URL with an OAuth token. */
export function hostedMcp(deps: HostedDeps): (request: Request) => Promise<Response> {
  const metadataUrl = new URL("/.well-known/oauth-protected-resource", deps.resource).href;
  const challenge = (extra = ""): string => `Bearer resource_metadata="${metadataUrl}"${extra}`;
  const windows = new Map<string, { minute: number; count: number }>();
  const overLimit = (agent: string): boolean => {
    const minute = Math.floor(deps.now() / 60_000);
    const window = windows.get(agent);
    if (window === undefined || window.minute !== minute) windows.set(agent, { minute, count: 1 });
    else window.count += 1;
    return (windows.get(agent)?.count ?? 0) > deps.perMinute;
  };

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return json(200, {
        resource: deps.resource,
        authorization_servers: [deps.issuer],
        scopes_supported: [...SCOPES],
        bearer_methods_supported: ["header"],
      });
    }
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const origin = request.headers.get("origin");
    if (origin !== null && !deps.allowedOrigins.includes(origin)) return new Response(null, { status: 403 });

    const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (bearer === undefined) return new Response(null, { status: 401, headers: { "www-authenticate": challenge() } });
    let granted: readonly string[];
    let agent: string;
    try {
      const claims = await verifyAccessToken(bearer, {
        issuer: deps.issuer,
        audience: deps.resource,
        keys: deps.keys(),
        now: Math.floor(deps.now() / 1000),
      });
      const approved = deps.agents(claims.agent);
      if (approved === undefined) throw new TokenRefused("this agent is not approved on this host");
      agent = claims.agent;
      granted = claims.scopes.filter((scope) => approved.scopes.includes(scope));
    } catch (error) {
      const reason = error instanceof TokenRefused ? error.message : "the token cannot be read";
      const headers = { "www-authenticate": challenge(`, error="invalid_token", error_description="${reason}"`) };
      return new Response(null, { status: 401, headers });
    }
    if (overLimit(agent)) return new Response(null, { status: 429, headers: { "retry-after": "60" } });

    const body: unknown = await request.json().catch(() => undefined);
    if (!isJsonObject(body) || body["jsonrpc"] !== "2.0" || typeof body["method"] !== "string") {
      return rpcError(400, null, -32600, "Invalid Request");
    }
    const { id, method, params } = body;
    const meta = isJsonObject(params) ? params["_meta"] : undefined;
    const bodyVersion = isJsonObject(meta) ? meta[VERSION_KEY] : undefined;
    const name = isJsonObject(params) ? (params["name"] ?? params["uri"]) : undefined;
    const named = method === "tools/call" || method === "resources/read";
    if (
      request.headers.get("mcp-protocol-version") !== bodyVersion ||
      request.headers.get("mcp-method") !== method ||
      (named && decodeHeader(request.headers.get("mcp-name")) !== name)
    ) {
      return rpcError(400, id, -32020, "HeaderMismatch: the MCP headers do not match the body");
    }
    if (bodyVersion !== VERSION) return rpcError(400, id, -32022, "Unsupported protocol version");
    if (id === undefined) return new Response(null, { status: 202 });

    const needed = requestScope(method, params);
    if (!granted.includes(needed)) {
      const extra = `, error="insufficient_scope", scope="${needed}"`;
      return new Response(null, { status: 403, headers: { "www-authenticate": challenge(extra) } });
    }
    const tool = method === "tools/call" ? (calledTool(params) ?? null) : null;
    return answer(deps, body, STREAMED.has(method), request.signal, (ok) =>
      deps.audit({ at: deps.now(), agent, method, tool, ok }),
    );
  };
}

/** Runs one request on its own MCP session: the reply as JSON, or an SSE stream for a subscription. */
function answer(
  deps: HostedDeps,
  body: object,
  streamed: boolean,
  signal: AbortSignal,
  done: (ok: boolean) => void,
): Promise<Response> {
  const lines = new TextEncoder();
  let receive: ((bytes: Uint8Array) => unknown) | undefined;
  let closeSession: (() => void) | undefined;
  const first = Promise.withResolvers<Response>();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const link: PushLink = {
    send: (bytes) => {
      const text = new TextDecoder().decode(bytes).trimEnd();
      if (stream !== undefined) return stream.enqueue(lines.encode(`data: ${text}\n\n`));
      const reply: unknown = JSON.parse(text);
      done(isJsonObject(reply) && !("error" in reply) && Reflect.get(Object(reply["result"]), "isError") !== true);
      first.resolve(new Response(`${text}\n`, { headers: { "content-type": "application/json" } }));
      link.close();
    },
    onData: (handler) => {
      receive = handler;
    },
    onClose: (handler) => {
      closeSession = handler;
    },
    close: () => {
      stream?.close();
      closeSession?.();
    },
  };
  deps.serve(link);
  signal.addEventListener("abort", () => link.close(), { once: true });
  if (streamed) {
    done(true);
    const events = new ReadableStream<Uint8Array>({ start: (controller) => void (stream = controller) });
    first.resolve(
      new Response(events, { headers: { "content-type": "text/event-stream", "x-accel-buffering": "no" } }),
    );
  }
  receive?.(lines.encode(`${JSON.stringify(body)}\n`));
  return first.promise;
}
