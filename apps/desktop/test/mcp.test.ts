import { afterEach, expect, test } from "bun:test";
import { mcpEndpointUrl, requestMcp } from "../src/main/mcp.ts";
import { isMcpAnswer, type LocalHostEndpoint } from "../src/shared/bridge.ts";

const token = "t".repeat(43);
const endpoint = (port: number): LocalHostEndpoint => ({ url: `ws://127.0.0.1:${port}/v1/hc`, token });

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: string;
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) void server.stop(true);
});

function hostAnswers(answer: () => Response) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      });
      return answer();
    },
  });
  servers.push(server);
  return { port: server.port ?? 0, seen };
}

test("the websocket endpoint names the plain-HTTP MCP route", () => {
  expect(mcpEndpointUrl({ url: "ws://127.0.0.1:52011/v1/hc?x=1", token })).toBe("http://127.0.0.1:52011/v1/mcp");
  expect(mcpEndpointUrl({ url: "wss://host.example/v1/hc", token })).toBe("https://host.example/v1/mcp");
});

test("reading asks with the token; on and off put the switch, and the host's answer is what comes back", async () => {
  const clients = [
    { id: "3FA94C0E", name: "Grok bot" },
    { id: "AB12CD34", name: null },
  ];
  const host = hostAnswers(() => Response.json({ enabled: true, clients }));
  expect(await requestMcp(endpoint(host.port), "state")).toEqual({ state: "read", enabled: true, clients });
  await requestMcp(endpoint(host.port), "on");
  await requestMcp(endpoint(host.port), "off");
  expect(host.seen).toEqual([
    { method: "GET", path: "/v1/mcp", authorization: `Bearer ${token}`, body: "" },
    { method: "PUT", path: "/v1/mcp", authorization: `Bearer ${token}`, body: '{"enabled":true}' },
    { method: "PUT", path: "/v1/mcp", authorization: `Bearer ${token}`, body: '{"enabled":false}' },
  ]);
});

test("an older host, a refused token and a failing host are each said in words, never thrown", async () => {
  const answers = await Promise.all(
    [404, 401, 500].map((status) => requestMcp(endpoint(hostAnswers(() => new Response("no", { status })).port), "on")),
  );
  expect(answers).toEqual([
    { state: "unavailable", reason: "This doriface-host is too old to accept MCP clients." },
    { state: "unavailable", reason: "This computer's host refused the request; start it again." },
    { state: "unavailable", reason: "This computer's host answered 500." },
  ]);
  expect(answers.every(isMcpAnswer)).toBe(true);
});

test("an answer in another shape is not trusted, and a host that is not there is unavailable", async () => {
  const bodies = [{ enabled: "yes", clients: [] }, { enabled: true }, { enabled: true, clients: [{ id: 7 }] }, "text"];
  const answers = await Promise.all(
    bodies.map((body) => requestMcp(endpoint(hostAnswers(() => Response.json(body)).port), "state")),
  );
  expect(answers).toEqual(
    bodies.map(() => ({
      state: "unavailable",
      reason: "This computer's host sent an MCP answer this app does not understand.",
    })),
  );
  const gone = hostAnswers(() => new Response("")).port;
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  expect((await requestMcp(endpoint(gone), "state")).state).toBe("unavailable");
});
