import { HcRpcError } from "@doriface/protocol";
import { expect, test } from "bun:test";
import type { PushLink } from "../push/push-stream.ts";
import type { CliResult } from "./hc-cli.ts";
import type { Scope } from "./one-tool.ts";
import { type HcCaller, serveMcpLines } from "./serve.ts";

const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
const SKILL = [
  { path: "SKILL.md", text: "# Doriterm\nRead me first." },
  { path: "references/hc.md", text: "# hc" },
];
const enc = new TextEncoder();
const dec = new TextDecoder();

interface Call {
  readonly method: string;
  readonly params: object;
  readonly signal: AbortSignal;
  readonly answer: PromiseWithResolvers<unknown>;
}

/** A link, a core and an hc CLI driven by hand: each reply resolves the next waiter, each core call waits for the test. */
function rig(scopes?: readonly Scope[]) {
  const replies: unknown[] = [];
  const waiters: (() => void)[] = [];
  let onData: ((bytes: Uint8Array) => unknown) | undefined;
  let onLinkClose: (() => void) | undefined;
  let closedWith: { readonly code: number | undefined; readonly reason: string | undefined } | undefined;
  const calls: Call[] = [];
  const called: (() => void)[] = [];
  const argvs: (readonly string[])[] = [];
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
    subscribe: () => Promise.reject(new Error("this rig serves no events")),
    onClose: (listener) => {
      coreClosed = listener;
    },
    close: () => {},
  };
  serveMcpLines(link, {
    hostVersion: "1.2.3",
    skill: SKILL,
    scopes,
    runHc: (argv): Promise<CliResult> => {
      argvs.push(argv);
      const exitCode = argv[0] === "get" ? 1 : 0;
      return Promise.resolve({
        exitCode,
        stdout: `ran ${argv.join(" ")}\n`,
        stderr: "",
        truncated: false,
        timedOut: false,
      });
    },
    openHc: () => {
      opened += 1;
      return Promise.resolve(core);
    },
  });
  const send = (message: object): void => void onData?.(enc.encode(`${JSON.stringify(message)}\n`));
  const run = (id: number, args: unknown, extra: object = {}): void =>
    send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { _meta: META, name: "doriterm", arguments: { args, ...extra } },
    });
  const reply = (): Promise<void> => new Promise((resolve) => waiters.push(resolve));
  const coreCall = (): Promise<void> => new Promise((resolve) => called.push(resolve));
  return {
    replies,
    calls,
    argvs,
    send,
    run,
    reply,
    coreCall,
    opened: () => opened,
    closed: () => closedWith,
    dropCore: () => coreClosed?.(new Error("the pipe closed")),
    endSession: () => onLinkClose?.(),
  };
}
const content = (reply: unknown): unknown =>
  Reflect.get(Object(Reflect.get(Object(reply), "result")), "structuredContent");

test("tools/list answers exactly one tool, doriterm, whose description opens by pointing at the skill", () => {
  const r = rig();
  r.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } });
  const tools: { name: string; description: string }[] = Reflect.get(
    Object(Reflect.get(Object(r.replies[0]), "result")),
    "tools",
  );
  expect(tools.map((tool) => tool.name)).toEqual(["doriterm"]);
  expect(tools[0]?.description.startsWith("Read doriterm://skill/SKILL.md before your first call")).toBe(true);
  expect(r.opened()).toBe(0);
});

test('the skill is a resource and a prompt, and args ["skill"] answers its text for clients that read neither', async () => {
  const r = rig();
  r.send({
    jsonrpc: "2.0",
    id: 1,
    method: "resources/read",
    params: { _meta: META, uri: "doriterm://skill/SKILL.md" },
  });
  expect(r.replies[0]).toMatchObject({
    result: { contents: [{ uri: "doriterm://skill/SKILL.md", text: SKILL[0]?.text }] },
  });
  r.send({ jsonrpc: "2.0", id: 2, method: "prompts/get", params: { _meta: META, name: "doriterm" } });
  expect(r.replies[1]).toMatchObject({ result: { messages: [{ role: "user", content: { text: SKILL[0]?.text } }] } });
  const answered = r.reply();
  r.run(3, ["skill"]);
  await answered;
  expect(content(r.replies[2])).toEqual({ exitCode: 0, stdout: SKILL[0]?.text, stderr: "" });
});

test("an hc verb runs as the hc CLI with exactly the args given; a nonzero exit is a tool error with its output", async () => {
  const r = rig();
  const both = Promise.all([r.reply(), r.reply()]);
  r.run(1, ["send", "t3", "hello there"]);
  r.run(2, ["get", "t9"]);
  await both;
  expect(r.argvs).toEqual([
    ["send", "t3", "hello there"],
    ["get", "t9"],
  ]);
  expect(r.replies[0]).toMatchObject({
    id: 1,
    result: { isError: false, structuredContent: { exitCode: 0, stdout: "ran send t3 hello there\n" } },
  });
  expect(r.replies[1]).toMatchObject({ id: 2, result: { isError: true, structuredContent: { exitCode: 1 } } });
  expect(r.opened()).toBe(0);
});

test("a refused verb and a verb outside the session's scopes answer a tool error and run nothing", async () => {
  const r = rig(["read"]);
  const all = Promise.all([r.reply(), r.reply(), r.reply()]);
  r.run(1, ["attach", "t1"]);
  r.run(2, ["send", "t1", "rm -rf ~"]);
  r.run(3, ["ls"]);
  await all;
  expect(content(r.replies[0])).toMatchObject({ kind: "refused" });
  expect(content(r.replies[1])).toEqual({ kind: "refused", message: "this needs the act scope" });
  expect(r.argvs).toEqual([["ls"]]);
});

test("arguments that do not fit are invalid params; any other tool name is unknown", () => {
  const r = rig();
  r.run(1, "ls");
  r.run(2, ["ls"], { timeoutSeconds: 601 });
  r.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { _meta: META, name: "terminal_list", arguments: {} },
  });
  expect(r.replies).toEqual([
    { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params: args must be a list of strings" } },
    {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32602, message: "Invalid params: timeoutSeconds must be a whole number from 1 to 600" },
    },
    { jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Unknown tool: terminal_list" } },
  ]);
});

test("doc get reaches the core with its method, and a herdr-core error comes back as a tool error with its kind", async () => {
  const r = rig();
  const reached = r.coreCall();
  r.run(4, ["doc", "get", "layout"]);
  await reached;
  expect(r.calls[0]).toMatchObject({ method: "doc.get", params: { name: "layout" } });
  const answered = r.reply();
  r.calls[0]?.answer.reject(new HcRpcError({ code: -32000, message: "not_found", data: { kind: "not_found" } }));
  await answered;
  expect(r.replies[0]).toMatchObject({ id: 4, result: { isError: true, structuredContent: { kind: "not_found" } } });
});

test("notifications/cancelled aborts the core call and nothing is written for it", async () => {
  const r = rig();
  const reached = r.coreCall();
  r.run(5, ["doc", "get", "a"]);
  await reached;
  r.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5 } });
  expect(r.calls[0]?.signal.aborted).toBe(true);
  // A later call is answered first, proving the cancelled one wrote nothing before it.
  const answered = r.reply();
  r.run(6, ["ls"]);
  await answered;
  expect(r.replies).toHaveLength(1);
  expect(r.replies[0]).toMatchObject({ id: 6 });
});

test("two core calls that settle out of order are both answered on one connection, each on one whole line", async () => {
  const r = rig();
  const both = Promise.all([r.coreCall(), r.coreCall()]);
  r.run(7, ["doc", "get", "a"]);
  r.run(8, ["doc", "get", "b"]);
  await both;
  expect(r.opened()).toBe(1);
  const first = r.reply();
  r.calls[1]?.answer.resolve({ text: "b" });
  await first;
  const second = r.reply();
  r.calls[0]?.answer.resolve({ text: "a" });
  await second;
  expect(r.replies.map((reply) => JSON.stringify(reply).match(/"id":(\d+)/)?.[1])).toEqual(["8", "7"]);
});

test("the pipe to the core dying answers the call in flight as unavailable, then ends the session 1011", async () => {
  const r = rig();
  const reached = r.coreCall();
  r.run(9, ["doc", "get", "a"]);
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
  r.run(11, ["doc", "get", "a"]);
  await reached;
  r.endSession();
  expect(r.calls[0]?.signal.aborted).toBe(true);
});
