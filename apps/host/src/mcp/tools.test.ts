import { HcRpcError, MCP_EXCLUDED_METHODS, MCP_TOOLS } from "@doriface/protocol";
import { expect, test } from "bun:test";
import type { PushLink } from "../push/push-stream.ts";
import { MESH_TOOLS } from "./mesh-tools.ts";
import { type HcCaller, serveMcpLines } from "./serve.ts";

const CATALOG_NAMES = [...MCP_TOOLS, ...MESH_TOOLS].map((tool) => tool.name);

const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
const enc = new TextEncoder();
const dec = new TextDecoder();

interface Call {
  readonly method: string;
  readonly params: object;
  readonly signal: AbortSignal;
  readonly answer: PromiseWithResolvers<unknown>;
}

/** A link and a core driven by hand: each reply resolves the next waiter, each core call waits for the test to answer. */
function rig() {
  const replies: unknown[] = [];
  const waiters: (() => void)[] = [];
  let onData: ((bytes: Uint8Array) => unknown) | undefined;
  let onLinkClose: (() => void) | undefined;
  let closedWith: { readonly code: number | undefined; readonly reason: string | undefined } | undefined;
  const calls: Call[] = [];
  const called: (() => void)[] = [];
  let coreClosed: ((error: Error | undefined) => void) | undefined;
  let opened = 0;
  const link: PushLink = {
    send: (bytes) => {
      const text = dec.decode(bytes);
      expect(text.endsWith("\n")).toBe(true);
      expect(text.indexOf("\n")).toBe(text.length - 1);
      replies.push(JSON.parse(text));
      waiters.shift()?.();
    },
    onData: (handler) => {
      onData = handler;
    },
    onClose: (handler) => {
      onLinkClose = handler;
    },
    close: (code, reason) => {
      closedWith = { code, reason };
      waiters.shift()?.();
    },
  };
  const core: HcCaller = {
    callByName: (method, params, { signal }) => {
      const answer = Promise.withResolvers<unknown>();
      calls.push({ method, params, signal, answer });
      signal.addEventListener("abort", () => answer.reject(new Error("aborted")));
      called.shift()?.();
      return answer.promise;
    },
    onClose: (listener) => {
      coreClosed = listener;
    },
    close: () => {},
  };
  serveMcpLines(link, {
    hostVersion: "1.2.3",
    openHc: () => {
      opened += 1;
      return Promise.resolve(core);
    },
  });
  const send = (message: object): void => void onData?.(enc.encode(`${JSON.stringify(message)}\n`));
  const call = (id: number, name: string, args?: unknown): void =>
    send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { _meta: META, name, ...(args === undefined ? {} : { arguments: args }) },
    });
  const reply = (): Promise<void> => new Promise((resolve) => waiters.push(resolve));
  const coreCall = (): Promise<void> => new Promise((resolve) => called.push(resolve));
  return {
    replies,
    calls,
    send,
    call,
    reply,
    coreCall,
    opened: () => opened,
    closed: () => closedWith,
    dropCore: () => coreClosed?.(new Error("the pipe closed")),
    endSession: () => onLinkClose?.(),
  };
}

const SHOW = "notifications/doriterm/tools";
const namesIn = (answer: unknown): readonly string[] =>
  (JSON.stringify(answer).match(/"name":"[a-z_]+"/g) ?? []).map((pair) => pair.slice(8, -1));

test("tools/list shows two tools until the session asks for more: a group adds to them, all replaces them", () => {
  const r = rig();
  const list = (id: number): void => r.send({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: META } });
  list(1);
  expect(namesIn(r.replies[0])).toEqual(["doriterm_tools", "doriterm_call"]);
  r.send({ jsonrpc: "2.0", method: SHOW, params: { tools: ["machine"] } });
  list(2);
  expect(namesIn(r.replies[1])).toEqual([
    "doriterm_tools",
    "doriterm_call",
    ...MCP_TOOLS.filter((tool) => tool.name.startsWith("machine_")).map((tool) => tool.name),
  ]);
  r.send({ jsonrpc: "2.0", method: SHOW, params: { tools: "all" } });
  list(3);
  expect(namesIn(r.replies[2])).toEqual(CATALOG_NAMES);
  r.send({ jsonrpc: "2.0", method: SHOW, params: { tools: 7 } });
  list(4);
  expect(namesIn(r.replies[3])).toEqual(["doriterm_tools", "doriterm_call"]);
  expect(r.replies).toHaveLength(4);
  expect(r.opened()).toBe(0);
});

test("both listed tools lead with the advice to search first, so a model learns the catalog exists", () => {
  const r = rig();
  r.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } });
  const tools: { name: string; description: string }[] = Reflect.get(
    Reflect.get(r.replies[0] ?? {}, "result") ?? {},
    "tools",
  );
  const [first, second] = tools.map((tool) => tool.description.split(":")[0]);
  expect(tools.map((tool) => tool.name)).toEqual(["doriterm_tools", "doriterm_call"]);
  expect(first).toBe(second);
  expect(first).toContain("doriterm_tools");
});

test("doriterm_tools answers the catalog without the core: names alone, or the matches with their schemas", () => {
  const r = rig();
  r.call(1, "doriterm_tools");
  r.call(2, "doriterm_tools", { query: "terminal_kill" });
  r.call(3, "doriterm_tools", { query: "terminal" });
  r.call(4, "doriterm_tools", { query: 5 });
  const content = (index: number): { tools: { name: string; inputSchema?: object }[]; more?: number } =>
    Reflect.get(Reflect.get(r.replies[index] ?? {}, "result") ?? {}, "structuredContent");
  expect(content(0).tools.map((tool) => tool.name)).toEqual(CATALOG_NAMES);
  expect(content(0).tools.every((tool) => tool.inputSchema === undefined)).toBe(true);
  expect(content(1).tools.map((tool) => tool.name)).toEqual(["terminal_kill"]);
  expect(content(1).tools[0]?.inputSchema).toEqual(
    MCP_TOOLS.find((tool) => tool.name === "terminal_kill")?.inputSchema,
  );
  const terminals = MCP_TOOLS.filter((tool) => `${tool.name} ${tool.description}`.toLowerCase().includes("terminal"));
  expect(content(2).tools).toHaveLength(8);
  expect(content(2).more).toBe(terminals.length - 8);
  expect(r.replies[3]).toEqual({
    jsonrpc: "2.0",
    id: 4,
    error: { code: -32602, message: "Invalid params: query must be a string" },
  });
  expect(r.opened()).toBe(0);
});

test("doriterm_call runs the named tool as a direct call would, and refuses what a direct call refuses", async () => {
  const r = rig();
  const reached = r.coreCall();
  r.call(1, "doriterm_call", { tool: "terminal_list", arguments: { all: true } });
  await reached;
  expect(r.calls[0]).toMatchObject({ method: "terminal.list", params: { all: true } });
  const refused = [
    "doriterm_call",
    "no_such_tool",
    ...MCP_EXCLUDED_METHODS.map((method) => method.replaceAll(".", "_")),
  ];
  refused.forEach((tool, index) => r.call(10 + index, "doriterm_call", { tool }));
  r.call(30, "doriterm_call", { tool: "terminal_list", arguments: [1] });
  r.call(31, "doriterm_call", {});
  expect(r.replies).toEqual([
    ...refused.map((tool, index) => ({
      jsonrpc: "2.0",
      id: 10 + index,
      error: { code: -32602, message: `Unknown tool: ${tool}` },
    })),
    { jsonrpc: "2.0", id: 30, error: { code: -32602, message: "Invalid params: arguments must be an object" } },
    { jsonrpc: "2.0", id: 31, error: { code: -32602, message: "Unknown tool: undefined" } },
  ]);
  expect(r.calls).toHaveLength(1);
});

test("the full list is the generated table, 25 of herdr-core's methods and none of the seven left out, then the mesh tools", () => {
  const r = rig();
  r.send({ jsonrpc: "2.0", method: SHOW, params: { tools: "all" } });
  r.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } });
  const [answer] = r.replies;
  expect(answer).toMatchObject({ id: 1, result: { resultType: "complete", ttlMs: 300_000, cacheScope: "private" } });
  const names: readonly string[] = JSON.stringify(answer).match(/"name":"[a-z_]+"/g) ?? [];
  expect(names).toEqual(CATALOG_NAMES.map((name) => `"name":"${name}"`));
  expect(MCP_TOOLS).toHaveLength(25);
  for (const method of MCP_EXCLUDED_METHODS) expect(MCP_TOOLS.some((tool) => tool.method === method)).toBe(false);
  expect(r.opened()).toBe(0);
});

test("a tool call reaches the core with the method from the table, never a name from the wire", async () => {
  const r = rig();
  const reached = r.coreCall();
  r.call(2, "terminal_list", { all: true });
  await reached;
  expect(r.calls[0]).toMatchObject({ method: "terminal.list", params: { all: true } });
  const answered = r.reply();
  r.calls[0]?.answer.resolve({ terminals: [] });
  await answered;
  expect(r.replies[0]).toEqual({
    jsonrpc: "2.0",
    id: 2,
    result: {
      resultType: "complete",
      content: [{ type: "text", text: '{"terminals":[]}' }],
      structuredContent: { terminals: [] },
      isError: false,
    },
  });
});

test("an unknown tool and each method left out are refused by name, and the core is never opened", () => {
  const r = rig();
  const names = ["no_such_tool", ...MCP_EXCLUDED_METHODS.map((method) => method.replaceAll(".", "_"))];
  names.forEach((name, index) => r.call(10 + index, name));
  expect(r.replies).toEqual(
    names.map((name, index) => ({
      jsonrpc: "2.0",
      id: 10 + index,
      error: { code: -32602, message: `Unknown tool: ${name}` },
    })),
  );
  expect(r.opened()).toBe(0);
});

test("arguments that are not an object are invalid params, not a call", () => {
  const r = rig();
  r.call(3, "terminal_list", [1]);
  expect(r.replies).toEqual([
    { jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Invalid params: arguments must be an object" } },
  ]);
});

test("a herdr-core error comes back as a tool error with its kind", async () => {
  const r = rig();
  const reached = r.coreCall();
  r.call(4, "terminal_get", { terminal: "t9" });
  await reached;
  const answered = r.reply();
  r.calls[0]?.answer.reject(new HcRpcError({ code: -32000, message: "not_found", data: { kind: "not_found" } }));
  await answered;
  expect(r.replies[0]).toMatchObject({
    id: 4,
    result: { isError: true, structuredContent: { kind: "not_found", message: "not_found" } },
  });
});

test("notifications/cancelled aborts the core call and nothing is written for it", async () => {
  const r = rig();
  const reached = r.coreCall();
  r.call(5, "terminal_wait", { terminal: "t1" });
  await reached;
  r.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5 } });
  expect(r.calls[0]?.signal.aborted).toBe(true);
  // A later call is answered first, proving the cancelled one wrote nothing before it.
  const second = r.coreCall();
  r.call(6, "terminal_list");
  await second;
  const answered = r.reply();
  r.calls[1]?.answer.resolve({ terminals: [] });
  await answered;
  expect(r.replies).toHaveLength(1);
  expect(r.replies[0]).toMatchObject({ id: 6 });
});

test("two calls that settle out of order are both answered, each on one whole line", async () => {
  const r = rig();
  const both = Promise.all([r.coreCall(), r.coreCall()]);
  r.call(7, "terminal_list");
  r.call(8, "machine_list");
  await both;
  expect(r.opened()).toBe(1);
  const first = r.reply();
  r.calls[1]?.answer.resolve({ machines: [] });
  await first;
  const second = r.reply();
  r.calls[0]?.answer.resolve({ terminals: [] });
  await second;
  expect(r.replies.map((reply) => JSON.stringify(reply).match(/"id":(\d+)/)?.[1])).toEqual(["8", "7"]);
});

test("the pipe to the core dying answers the call in flight as unavailable, then ends the session 1011", async () => {
  const r = rig();
  const reached = r.coreCall();
  r.call(9, "terminal_wait", { terminal: "t1" });
  await reached;
  r.dropCore();
  expect(r.closed()).toBeUndefined();
  const answered = r.reply();
  r.calls[0]?.answer.reject(new Error("connection is closed"));
  await answered;
  expect(r.replies[0]).toMatchObject({ id: 9, result: { isError: true, structuredContent: { kind: "unavailable" } } });
  expect(r.closed()).toEqual({ code: 1011, reason: "the connection to the core closed" });
});

test("ending the session aborts calls in flight", async () => {
  const r = rig();
  const reached = r.coreCall();
  r.call(11, "terminal_wait", { terminal: "t1" });
  await reached;
  r.endSession();
  expect(r.calls[0]?.signal.aborted).toBe(true);
});
