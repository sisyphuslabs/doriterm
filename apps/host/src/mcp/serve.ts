import { CloseCode } from "@doriface/crypto";
import { HcRpcError, type HcMethod } from "@doriface/protocol";
import type { PushLink } from "../push/push-stream.ts";
import type { MeshToolDeps } from "./mesh-tools.ts";
import { type Id, MAX_MCP_LINE, type McpLine, readMcpLine, toolResult, type ToolsShown } from "./lines.ts";

const encoder = new TextEncoder();

/** What the MCP server needs of a herdr-core connection; an HcConnection is one. */
export interface HcCaller {
  callByName(method: HcMethod, params: object, options: { readonly signal: AbortSignal }): Promise<unknown>;
  onClose(listener: (error: Error | undefined) => void): unknown;
  close(): void;
}

export interface McpServeDeps {
  readonly hostVersion: string;
  /** Opens this session's own connection to the core, on its first tool call. */
  readonly openHc?: (() => Promise<HcCaller>) | undefined;
  /** The running host's mesh and devices; a host without stored state has none. */
  readonly mesh?: MeshToolDeps | undefined;
}

/** One LF-delimited JSON-RPC message at a time; tool calls run concurrently and each reply is one whole line. */
export function serveMcpLines(link: PushLink, deps: McpServeDeps): void {
  let pending: Uint8Array | undefined;
  let length = 0;
  let closed = false;
  let dying = false;
  let shown: ToolsShown = "core";
  let hc: Promise<HcCaller> | undefined;
  const calls = new Map<Id, AbortController>();
  const close = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    link.close(code, reason);
  };
  const send = (reply: object): void => {
    if (closed) return;
    const output = encoder.encode(`${JSON.stringify(reply)}\n`);
    if (output.length > MAX_MCP_LINE) return close(CloseCode.CryptoFailure, "an MCP reply is too long");
    link.send(output);
  };
  // The pipe to the core died: calls in flight answer "unavailable", then the session ends so the client reconnects.
  const settleDying = (): void => {
    if (dying && calls.size === 0) close(1011, "the connection to the core closed");
  };
  const openHc = (): Promise<HcCaller> => {
    if (deps.openHc === undefined) return Promise.reject(new Error("this host serves no MCP tools"));
    hc ??= deps.openHc().then(
      (connection) => {
        connection.onClose(() => {
          dying = !closed;
          settleDying();
        });
        if (closed) connection.close();
        return connection;
      },
      (error: unknown) => {
        hc = undefined;
        throw error;
      },
    );
    return hc;
  };
  const run = async (line: Extract<McpLine, { kind: "call" }>): Promise<void> => {
    const abort = new AbortController();
    calls.set(line.id, abort);
    try {
      const connection = await openHc();
      const value = await connection.callByName(line.tool.method, line.args, { signal: abort.signal });
      send({ jsonrpc: "2.0", id: line.id, result: toolResult(value, false) });
    } catch (error) {
      if (abort.signal.aborted) return;
      const failure =
        error instanceof HcRpcError
          ? { kind: error.kind, message: error.message }
          : { kind: "unavailable", message: error instanceof Error ? error.message : String(error) };
      send({ jsonrpc: "2.0", id: line.id, result: toolResult(failure, true) });
    } finally {
      calls.delete(line.id);
      settleDying();
    }
  };
  // A mesh tool runs in this host, not on the core; what it refuses comes back as a tool error with its words.
  const runMesh = async (line: Extract<McpLine, { kind: "mesh" }>): Promise<void> => {
    try {
      if (deps.mesh === undefined) throw new Error("this host keeps no state, so it has no mesh or devices");
      send({ jsonrpc: "2.0", id: line.id, result: toolResult(await line.tool.run(line.args, deps.mesh), false) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({ jsonrpc: "2.0", id: line.id, result: toolResult({ kind: "refused", message }, true) });
    }
  };
  link.onClose(() => {
    closed = true;
    for (const abort of calls.values()) abort.abort();
    void hc?.then(
      (connection) => connection.close(),
      () => undefined,
    );
  });
  link.onData((bytes) => {
    for (let start = 0; start < bytes.length;) {
      if (closed) return;
      const lf = bytes.indexOf(10, start);
      const part = bytes.subarray(start, lf === -1 ? bytes.length : lf);
      if (length + part.length >= MAX_MCP_LINE) return close(CloseCode.CryptoFailure, "an MCP line is too long");
      if (lf === -1 || length > 0) {
        pending ??= new Uint8Array(MAX_MCP_LINE - 1);
        pending.set(part, length);
        length += part.length;
      }
      if (lf === -1) return;
      const bytesOfLine = length > 0 ? (pending?.subarray(0, length) ?? part) : part;
      length = 0;
      start = lf + 1;
      let line: McpLine;
      try {
        line = readMcpLine(bytesOfLine, deps.hostVersion, shown);
      } catch {
        return close(CloseCode.CryptoFailure, "an MCP line is not a UTF-8 JSON object");
      }
      if (line.kind === "reply") send(line.reply);
      else if (line.kind === "show") shown = line.shown;
      else if (line.kind === "cancel") {
        const key = line.requestId;
        if (typeof key === "string" || typeof key === "number") calls.get(key)?.abort();
      } else if (line.kind === "call") void run(line);
      else if (line.kind === "mesh") void runMesh(line);
    }
  });
}
