import { isRecord } from "../state/files.ts";

export const MAX_MCP_LINE = 256 * 1024;
const VERSION = "2026-07-28";
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
type Id = string | number | null;

const rpcError = (id: Id, code: number, message: string, data?: object) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, data },
});

/** Decodes one complete line without its LF, then dispatches only the methods this host serves. */
export function replyToMcpLine(bytes: Uint8Array, hostVersion: string): object | undefined {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  if (!isRecord(value)) throw new Error("an MCP line must be a JSON object");

  const { jsonrpc, method, id, params } = value;
  if (jsonrpc !== "2.0" || typeof method !== "string") return rpcError(null, -32600, "Invalid Request");
  if (id === undefined) return undefined;
  if (id !== null && typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id))) {
    return rpcError(null, -32600, "Invalid Request");
  }
  const meta = isRecord(params) ? params["_meta"] : undefined;
  const version = isRecord(meta) ? meta[VERSION_KEY] : undefined;
  if (version !== VERSION) {
    return rpcError(id, -32022, "Unsupported protocol version", {
      supported: [VERSION],
      requested: typeof version === "string" ? version : null,
    });
  }
  switch (method) {
    case "server/discover":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          supportedVersions: [VERSION],
          capabilities: {},
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "doriterm", version: hostVersion } },
        },
      };
    default:
      return rpcError(id, -32601, "Method not found");
  }
}
