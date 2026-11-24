import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { openOnCore, spawnHcLink } from "../mesh/hc-machines.ts";
import type { PushLink } from "../push/push-stream.ts";
import { createHcSession, type HcSession } from "../testing/hc-session.ts";
import { serveMcpLines } from "./serve.ts";

setDefaultTimeout(30_000);
let session: HcSession;
beforeAll(() => {
  session = createHcSession("doriface-mcp-tools-test");
});
afterAll(async () => {
  await session.dispose();
});

test("terminal_list through the MCP server reaches a real herdr-core and returns its answer", async () => {
  const target = { hc: session.hc, session: session.name, env: session.env };
  const answered = Promise.withResolvers<unknown>();
  let onData: ((bytes: Uint8Array) => unknown) | undefined;
  let onClose: (() => void) | undefined;
  const link: PushLink = {
    send: (bytes) => answered.resolve(JSON.parse(new TextDecoder().decode(bytes))),
    onData: (handler) => {
      onData = handler;
    },
    onClose: (handler) => {
      onClose = handler;
    },
    close: () => onClose?.(),
  };
  serveMcpLines(link, { hostVersion: "0", openHc: () => openOnCore(spawnHcLink(target), target) });
  const call = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      name: "terminal_list",
      arguments: {},
    },
  };
  onData?.(new TextEncoder().encode(`${JSON.stringify(call)}\n`));
  const reply = await answered.promise;
  onClose?.();
  expect(reply).toMatchObject({ id: 1, result: { isError: false, structuredContent: { terminals: [] } } });
});
