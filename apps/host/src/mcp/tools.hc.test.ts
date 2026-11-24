import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { openOnCore, spawnHcLink } from "../mesh/hc-machines.ts";
import type { PushLink } from "../push/push-stream.ts";
import { createHcSession, type HcSession } from "../testing/hc-session.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hcCli } from "./hc-cli.ts";
import { serveMcpLines } from "./serve.ts";

setDefaultTimeout(30_000);
let session: HcSession;
beforeAll(() => {
  session = createHcSession("doriface-mcp-tools-test");
});
afterAll(async () => {
  await session.dispose();
});

test("the one tool runs real hc commands on the host's session: ls, exec, and a file written from stdin then read", async () => {
  const target = { hc: session.hc, session: session.name, env: session.env };
  const replies = new Map<number, PromiseWithResolvers<unknown>>();
  let onData: ((bytes: Uint8Array) => unknown) | undefined;
  let onClose: (() => void) | undefined;
  const link: PushLink = {
    send: (bytes) => {
      const reply: unknown = JSON.parse(new TextDecoder().decode(bytes));
      replies.get(Number(Reflect.get(Object(reply), "id")))?.resolve(reply);
    },
    onData: (handler) => {
      onData = handler;
    },
    onClose: (handler) => {
      onClose = handler;
    },
    close: () => onClose?.(),
  };
  serveMcpLines(link, {
    hostVersion: "0",
    runHc: hcCli(target),
    openHc: () => openOnCore(spawnHcLink(target), target),
  });
  const run = async (id: number, args: readonly string[], stdin?: string): Promise<unknown> => {
    const reply = Promise.withResolvers<unknown>();
    replies.set(id, reply);
    const params = {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      name: "doriterm",
      arguments: { args, stdin },
    };
    onData?.(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params })}\n`));
    return Reflect.get(Object(Reflect.get(Object(await reply.promise), "result")), "structuredContent");
  };
  const listed = await run(1, ["ls"]);
  expect(listed).toMatchObject({ exitCode: 0 });
  expect(JSON.parse(String(Reflect.get(Object(listed), "stdout")))).toMatchObject({ terminals: [] });
  expect(await run(2, ["exec", "echo hello from hc"])).toMatchObject({ exitCode: 0, stdout: "hello from hc\n" });
  const path = join(mkdtempSync(join(tmpdir(), "dh-one-tool-")), "note.txt");
  expect(await run(3, ["file", "write", path], "written over MCP\n")).toMatchObject({ exitCode: 0 });
  expect(String(Reflect.get(Object(await run(4, ["file", "read", path])), "stdout"))).toContain("written over MCP");
  onClose?.();
});
