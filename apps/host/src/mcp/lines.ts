import { isJsonObject, type JsonObject, MCP_TOOLS, type McpToolRow } from "@doriface/protocol";

export const MAX_MCP_LINE = 256 * 1024;
const VERSION = "2026-07-28";
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
export type Id = string | number | null;

/** What one line asks for: an answer now, nothing, a cancellation, or a tool call to run. */
export type McpLine =
  | { readonly kind: "reply"; readonly reply: object }
  | { readonly kind: "none" }
  | { readonly kind: "cancel"; readonly requestId: unknown }
  | { readonly kind: "call"; readonly id: Id; readonly tool: McpToolRow; readonly args: JsonObject };

export const rpcError = (id: Id, code: number, message: string, data?: object) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, data },
});
const result = (id: Id, value: object): McpLine => ({ kind: "reply", reply: { jsonrpc: "2.0", id, result: value } });
const toolByName = new Map(MCP_TOOLS.map((row) => [row.name, row]));

/** Decodes one complete line without its LF and decides what it asks for; only the methods this host serves exist. */
export function readMcpLine(bytes: Uint8Array, hostVersion: string): McpLine {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  if (!isJsonObject(value)) throw new Error("an MCP line must be a JSON object");
  const { jsonrpc, method, id, params } = value;
  if (jsonrpc !== "2.0" || typeof method !== "string")
    return { kind: "reply", reply: rpcError(null, -32600, "Invalid Request") };
  if (id === undefined) {
    if (method === "notifications/cancelled" && isJsonObject(params))
      return { kind: "cancel", requestId: params["requestId"] };
    return { kind: "none" };
  }
  if (id !== null && typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id))) {
    return { kind: "reply", reply: rpcError(null, -32600, "Invalid Request") };
  }
  const meta = isJsonObject(params) ? params["_meta"] : undefined;
  const version = isJsonObject(meta) ? meta[VERSION_KEY] : undefined;
  if (version !== VERSION) {
    const data = { supported: [VERSION], requested: typeof version === "string" ? version : null };
    return { kind: "reply", reply: rpcError(id, -32022, "Unsupported protocol version", data) };
  }
  switch (method) {
    case "server/discover":
      return result(id, {
        resultType: "complete",
        supportedVersions: [VERSION],
        capabilities: { tools: {} },
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "doriterm", version: hostVersion } },
      });
    case "tools/list":
      return result(id, {
        resultType: "complete",
        tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        ttlMs: 300_000,
        cacheScope: "private",
      });
    case "tools/call": {
      const name = isJsonObject(params) ? params["name"] : undefined;
      const tool = typeof name === "string" ? toolByName.get(name) : undefined;
      if (tool === undefined) return { kind: "reply", reply: rpcError(id, -32602, `Unknown tool: ${String(name)}`) };
      const args = isJsonObject(params) ? (params["arguments"] ?? {}) : {};
      if (!isJsonObject(args))
        return { kind: "reply", reply: rpcError(id, -32602, "Invalid params: arguments must be an object") };
      return { kind: "call", id, tool, args };
    }
    default:
      return { kind: "reply", reply: rpcError(id, -32601, "Method not found") };
  }
}
