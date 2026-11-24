import type { JsonWebKey } from "node:crypto";
import { beforeAll, expect, test } from "bun:test";
import type { PushLink } from "../push/push-stream.ts";
import { type AuditLine, type HostedDeps, hostedMcp } from "./http.ts";

const ISSUER = "https://doriterm.com";
const RESOURCE = "https://h1.mcp.doriterm.com/mcp";
const VERSION = "2026-07-28";
let keys: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };

const b64url = (text: string | Uint8Array): string =>
  Buffer.from(typeof text === "string" ? new TextEncoder().encode(text) : text).toString("base64url");
async function token(claims: object = {}): Promise<string> {
  const body = { iss: ISSUER, aud: RESOURCE, sub: "dots", scope: "read act", exp: 9e9, ...claims };
  const input = `${b64url('{"alg":"ES256","kid":"k1"}')}.${b64url(JSON.stringify(body))}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

beforeAll(async () => {
  keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" };
});

/** An endpoint whose MCP session answers every request line with { echo: method } under the request's id. */
function endpoint(over: Partial<HostedDeps> = {}) {
  const audit: AuditLine[] = [];
  const served: string[] = [];
  const deps: HostedDeps = {
    resource: RESOURCE,
    issuer: ISSUER,
    keys: () => [jwk],
    agents: (id) => (id === "dots" ? { name: "Dots", scopes: ["read", "act"] } : undefined),
    allowedOrigins: [],
    perMinute: 100,
    now: () => 1_700_000_000_000,
    audit: (line) => audit.push(line),
    serve: (link: PushLink) => {
      link.onData((bytes) => {
        const line = JSON.parse(new TextDecoder().decode(bytes));
        served.push(line.method);
        link.send(
          new TextEncoder().encode(
            `${JSON.stringify({ jsonrpc: "2.0", id: line.id, result: { echo: line.method } })}\n`,
          ),
        );
      });
    },
    ...over,
  };
  return { handle: hostedMcp(deps), audit, served };
}

async function post(
  handle: (request: Request) => Promise<Response>,
  body: object,
  headers: Record<string, string> = {},
) {
  const method = Reflect.get(body, "method");
  const name = Reflect.get(Object(Reflect.get(body, "params")), "name");
  return handle(
    new Request(RESOURCE, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${await token()}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": VERSION,
        "mcp-method": String(method),
        ...(typeof name === "string" ? { "mcp-name": name } : {}),
        ...headers,
      },
    }),
  );
}
const call = (id: number, name: string, args: object = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": VERSION } },
});

test("an approved agent's tools/call is answered as one JSON reply, and the audit line names the tool, not its arguments", async () => {
  const { handle, audit } = endpoint();
  const response = await post(handle, call(1, "terminal_list", { all: true }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { echo: "tools/call" } });
  expect(audit).toEqual([
    { at: 1_700_000_000_000, agent: "dots", method: "tools/call", tool: "terminal_list", ok: true },
  ]);
});

test("no token answers 401 with where the protected resource metadata is", async () => {
  const { handle, served } = endpoint();
  const response = await post(handle, call(1, "terminal_list"), { authorization: "" });
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe(
    'Bearer resource_metadata="https://h1.mcp.doriterm.com/.well-known/oauth-protected-resource"',
  );
  expect(served).toEqual([]);
});

test("a token for an agent the person revoked, or never approved, is refused as invalid", async () => {
  const { handle, served } = endpoint({ agents: () => undefined });
  const response = await post(handle, call(1, "terminal_list"));
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  expect(served).toEqual([]);
});

test("a read-only agent calling a tool that acts is refused 403 insufficient_scope, through doriterm_call too", async () => {
  const { handle, served } = endpoint({ agents: () => ({ name: "Dots", scopes: ["read"] }) });
  const bodies = [call(1, "terminal_send", { text: "ls" }), call(2, "doriterm_call", { tool: "file_write" })];
  const refused = await Promise.all(bodies.map((body) => post(handle, body)));
  expect(refused.map((response) => response.status)).toEqual([403, 403]);
  for (const response of refused) {
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope", scope="act"');
  }
  expect((await post(handle, call(3, "doriterm_call", { tool: "file_read" }))).status).toBe(200);
  expect(served).toEqual(["tools/call"]);
});

test("the token's scopes narrow the agent's: a token without act cannot act even for an agent allowed to", async () => {
  const { handle } = endpoint();
  const response = await handle(
    new Request(RESOURCE, {
      method: "POST",
      body: JSON.stringify(call(1, "terminal_send")),
      headers: {
        authorization: `Bearer ${await token({ scope: "read" })}`,
        "mcp-protocol-version": VERSION,
        "mcp-method": "tools/call",
        "mcp-name": "terminal_send",
      },
    }),
  );
  expect(response.status).toBe(403);
});

test("headers that disagree with the body are refused 400 with HeaderMismatch before anything runs", async () => {
  const { handle, served } = endpoint();
  const mismatched = [
    { "mcp-name": "terminal_kill" },
    { "mcp-method": "tools/list" },
    { "mcp-protocol-version": "2025-11-25" },
  ];
  const responses = await Promise.all(mismatched.map((headers) => post(handle, call(1, "terminal_list"), headers)));
  expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
  const replies = await Promise.all(responses.map((response) => response.json()));
  for (const reply of replies) expect(reply).toMatchObject({ error: { code: -32020 } });
  expect(served).toEqual([]);
});

test("an Origin that is not allowed is 403, and GET or DELETE on the endpoint is 405", async () => {
  const { handle } = endpoint();
  expect((await post(handle, call(1, "terminal_list"), { origin: "https://evil.example" })).status).toBe(403);
  expect((await handle(new Request(RESOURCE, { method: "GET" }))).status).toBe(405);
  expect((await handle(new Request(RESOURCE, { method: "DELETE" }))).status).toBe(405);
});

test("past the per-minute limit an agent gets 429 until the minute turns", async () => {
  let now = 1_700_000_000_000;
  const { handle } = endpoint({ perMinute: 2, now: () => now });
  expect((await post(handle, call(1, "terminal_list"))).status).toBe(200);
  expect((await post(handle, call(2, "terminal_list"))).status).toBe(200);
  expect((await post(handle, call(3, "terminal_list"))).status).toBe(429);
  now += 60_000;
  expect((await post(handle, call(4, "terminal_list"))).status).toBe(200);
});

test("the protected resource metadata names this resource, its issuer and the scopes", async () => {
  const { handle } = endpoint();
  const response = await handle(new Request("https://h1.mcp.doriterm.com/.well-known/oauth-protected-resource"));
  expect(await response.json()).toEqual({
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: ["read", "act", "mesh"],
    bearer_methods_supported: ["header"],
  });
});
