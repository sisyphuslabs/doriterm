import { createMemoryLinkPair } from "@doriface/client";
import { expect, test } from "bun:test";
import { listBrowserMcpTerminals, openBrowserMcp } from "./browser-mcp.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

test("closing settings aborts the pending relay upgrade with the caller's reason", async () => {
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      arrived.resolve();
      return release.promise;
    },
  });
  const controller = new AbortController();
  const reason = new Error("settings closed");
  try {
    const attempt = openBrowserMcp(
      {
        ...DEFAULT_SETTINGS,
        hostId: "a".repeat(26),
        hostKey: "paired",
        relayUrl: server.url.href,
      },
      controller.signal,
    ).catch((error: unknown) => error);
    await Promise.race([
      arrived.promise,
      attempt.then(() => {
        throw new Error("dial ended before upgrade");
      }),
    ]);
    controller.abort(reason);
    release.resolve(new Response(null, { status: 503 }));
    expect(await attempt).toBe(reason);
  } finally {
    release.resolve(new Response(null, { status: 503 }));
    await server.stop(true);
  }
});

test("the browser discovers tools, requests only the terminal list and disconnects", async () => {
  const [browser, host] = createMemoryLinkPair();
  const closed = Promise.withResolvers<void>();
  host.onClose(() => closed.resolve());
  const methods: string[] = [];
  host.onData((bytes) => {
    const line = JSON.parse(new TextDecoder().decode(bytes));
    methods.push(line.method);
    const result =
      line.method === "server/discover"
        ? { capabilities: { tools: {} } }
        : line.method === "tools/list"
          ? { tools: [{ name: "doriterm_call" }] }
          : { isError: false, structuredContent: { terminals: [{ address: "t7" }] } };
    if (line.method === "tools/call") {
      expect(line.params.arguments).toEqual({ tool: "terminal_list", arguments: {} });
    }
    const data = new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: line.id, result })}\n`);
    host.send(data.subarray(0, 4));
    host.send(data.subarray(4));
  });
  expect(await listBrowserMcpTerminals(browser, new AbortController().signal)).toEqual(["t7"]);
  await closed.promise;
  expect(methods).toEqual(["server/discover", "tools/list", "tools/call"]);
});

test("unpaired settings are refused before dialing, and a closed stream cannot return a list", async () => {
  const signal = new AbortController().signal;
  await expect(openBrowserMcp(DEFAULT_SETTINGS, signal)).rejects.toThrow("Pair this browser");
  const [browser, host] = createMemoryLinkPair();
  host.onData(() => host.close());
  await expect(listBrowserMcpTerminals(browser, signal)).rejects.toThrow("closed");
});
