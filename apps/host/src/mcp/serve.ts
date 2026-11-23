import { CloseCode } from "@doriface/crypto";
import type { PushLink } from "../push/push-stream.ts";
import { MAX_MCP_LINE, replyToMcpLine } from "./lines.ts";

const encoder = new TextEncoder();

/** One LF-delimited JSON-RPC message at a time, with a byte bound independent of the chunk boundaries. */
export function serveMcpLines(link: PushLink, { hostVersion }: { readonly hostVersion: string }): void {
  let pending: Uint8Array | undefined;
  let length = 0;
  let closed = false;
  const refuse = (reason: string): void => {
    closed = true;
    link.close(CloseCode.CryptoFailure, reason);
  };
  link.onClose(() => {
    closed = true;
  });
  link.onData((bytes) => {
    for (let start = 0; start < bytes.length;) {
      if (closed) return;
      const lf = bytes.indexOf(10, start);
      const part = bytes.subarray(start, lf === -1 ? bytes.length : lf);
      if (length + part.length >= MAX_MCP_LINE) return refuse("an MCP line is too long");
      if (lf === -1 || length > 0) {
        pending ??= new Uint8Array(MAX_MCP_LINE - 1);
        pending.set(part, length);
        length += part.length;
      }
      if (lf === -1) return;
      const line = length > 0 ? (pending?.subarray(0, length) ?? part) : part;
      length = 0;
      start = lf + 1;
      let reply: object | undefined;
      try {
        reply = replyToMcpLine(line, hostVersion);
      } catch {
        return refuse("an MCP line is not a UTF-8 JSON object");
      }
      if (reply === undefined) continue;
      const output = encoder.encode(`${JSON.stringify(reply)}\n`);
      if (output.length > MAX_MCP_LINE) return refuse("an MCP reply is too long");
      link.send(output);
    }
  });
}
