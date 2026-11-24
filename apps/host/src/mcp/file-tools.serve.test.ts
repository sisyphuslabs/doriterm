import { expect, test } from "bun:test";
import type { PushLink } from "../push/push-stream.ts";
import { type HcCaller, serveMcpLines } from "./serve.ts";

const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };

function session(execReply: unknown) {
  const replies: unknown[] = [];
  const answered = Promise.withResolvers<void>();
  let onData: ((bytes: Uint8Array) => unknown) | undefined;
  const calls: { readonly method: string; readonly params: object }[] = [];
  const link: PushLink = {
    send: (bytes) => {
      replies.push(JSON.parse(new TextDecoder().decode(bytes)));
      answered.resolve();
    },
    onData: (handler) => {
      onData = handler;
    },
    onClose: () => {},
    close: () => answered.resolve(),
  };
  const core: HcCaller = {
    callByName: (method, params) => {
      calls.push({ method, params });
      return Promise.resolve(execReply);
    },
    subscribe: () => Promise.reject(new Error("no events here")),
    onClose: () => {},
    close: () => {},
  };
  serveMcpLines(link, { hostVersion: "1", openHc: () => Promise.resolve(core) });
  const call = (name: string, args: object): void => {
    const line = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args, _meta: META } };
    onData?.(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
  };
  return { replies, answered: answered.promise, calls, call };
}

const exec = (stdout: string, code = 0) => ({
  code,
  ms: 1,
  stdout: Buffer.from(stdout).toString("base64"),
  stderr: "",
  timed_out: false,
  truncated: false,
});

test("a file tool called through doriterm_call runs as machine.exec on the session's own core connection", async () => {
  const s = session(exec("regular file\t12\t1700000000\n"));
  s.call("doriterm_call", { tool: "file_stat", arguments: { path: "/srv/a.txt", on: "studio" } });
  await s.answered;
  expect(s.calls).toHaveLength(1);
  expect(s.calls[0]).toMatchObject({ method: "machine.exec", params: { on: "studio" } });
  const argv: unknown = Reflect.get(Object(s.calls[0]?.params), "argv");
  expect(Array.isArray(argv) && [argv[0], argv[1], argv.at(-1)]).toEqual(["sh", "-c", "/srv/a.txt"]);
  expect(s.replies[0]).toMatchObject({
    id: 7,
    result: { isError: false, structuredContent: { path: "/srv/a.txt", type: "file", size: 12, mtime: 1700000000 } },
  });
});

test("a refused path comes back as a tool error with its words, not a protocol error", async () => {
  const s = session(exec("", 3));
  s.call("file_stat", { path: "/nope" });
  await s.answered;
  expect(s.replies[0]).toMatchObject({
    id: 7,
    result: { isError: true, structuredContent: { kind: "refused", message: "/nope: no such file or folder" } },
  });
});
