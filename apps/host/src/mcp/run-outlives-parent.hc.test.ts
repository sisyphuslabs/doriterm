import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import { eventAddress, isJsonObject } from "@doriface/protocol";
import { openOnCore, spawnHcLink } from "../mesh/hc-machines.ts";
import type { PushLink } from "../push/push-stream.ts";
import { createHcSession, type HcSession } from "../testing/hc-session.ts";
import { serveMcpLines } from "./serve.ts";

setDefaultTimeout(30_000);
let session: HcSession;
let core: HcConnection;
beforeAll(async () => {
  session = createHcSession("doriface-mcp-outlive-test");
  const target = { hc: session.hc, session: session.name, env: session.env };
  core = await openOnCore(spawnHcLink(target), target);
});
afterAll(async () => {
  core.close();
  await session.dispose();
});

/** One MCP tool call through the host's MCP server, answered by the real core: its structured result. */
async function mcpCall(name: string, args: object): Promise<Record<string, unknown>> {
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
  const params = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" }, name, arguments: args };
  onData?.(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params })}\n`));
  const reply = await answered.promise;
  onClose?.();
  const result = isJsonObject(reply) ? reply["result"] : undefined;
  const content = isJsonObject(result) && result["isError"] === false ? result["structuredContent"] : undefined;
  if (!isJsonObject(content)) throw new Error(`${name} failed: ${JSON.stringify(reply)}`);
  return content;
}

test("a terminal an agent starts through the MCP server keeps running, ownerless, once its parent is killed (#2990)", async () => {
  const lead = await core.call("terminal.run", { argv: ["sh", "-c", "sleep 600"], no_parent: true });
  const child = await mcpCall("terminal_run", { argv: ["sh", "-c", "sleep 600"], parent: lead.address });
  expect(child).toMatchObject({ parent: lead.address, die_with_parent: false, state: "live" });
  const feed = await core.subscribe();
  const leadFinished = Promise.withResolvers<void>();
  feed.onEvent((event) => {
    if (event.type === "finished" && eventAddress(event) === lead.address) leadFinished.resolve();
  });
  await core.call("terminal.kill", { terminal: lead.address });
  await leadFinished.promise;
  const after = await core.call("terminal.get", { terminal: String(child["address"]) });
  expect({ state: after.state, reason: after.reason ?? null, parent: after.parent }).toEqual({
    state: "live",
    reason: null,
    parent: lead.address,
  });
  await core.call("terminal.kill", { terminal: after.address });
});
