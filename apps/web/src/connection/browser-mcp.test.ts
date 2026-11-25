import { createMemoryLinkPair } from "@doriface/client";
import { expect, test } from "bun:test";
import { listBrowserMcpTerminals, openBrowserMcp } from "./browser-mcp.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

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
