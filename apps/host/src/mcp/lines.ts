import { isJsonObject, type JsonObject, MCP_TOOLS, type McpToolRow } from "@doriface/protocol";
import { MESH_TOOLS, type MeshTool } from "./mesh-tools.ts";
import {
  EVENT_TYPE,
  EVENTS_EXTENSION,
  readListen,
  readResourceUri,
  readStream,
  type ListenFilter,
  type StreamRequest,
} from "./subscriptions.ts";

export const MAX_MCP_LINE = 256 * 1024;
const VERSION = "2026-07-28";
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
export type Id = string | number | null;

/**
 * Which tools `tools/list` shows this session: `"core"` is the two below, `"all"` every catalog tool, and a list of
 * groups (the word before a tool name's first `_`) those groups after the core two. It only saves the client's context:
 * every catalog tool can be called by name whatever is shown.
 */
export type ToolsShown = "core" | "all" | readonly string[];

/** The bridge's first line (`doriface-host connect --mcp --tools ...`): a notification, so an older host ignores it. */
export const TOOLS_SHOWN_METHOD = "notifications/doriterm/tools";
const SEARCH_LIMIT = 8;

const SEARCH_FIRST =
  "Search doriterm_tools before calling anything: most Doriterm tools are not listed until searched.";

/**
 * What server/discover tells the model about this server (DiscoverResult.instructions in 2026-07-28). Most tools are
 * deliberately not in tools/list, so a model that does not know to search would conclude they do not exist.
 */
export const SERVER_INSTRUCTIONS =
  "Doriterm reaches the terminals, files and mesh of the machine this session is paired with. " +
  "Only two tools are listed: doriterm_tools and doriterm_call. Many more exist (terminals, machines, files, " +
  "documents, the mesh and its devices). Before you call anything, search with doriterm_tools, using a few words for " +
  "what you want to do, for example 'read terminal screen' or 'approve join'; then call the tool it returns with " +
  "doriterm_call. Search again whenever a task needs a tool you have not seen. To wait for a terminal to finish or " +
  "change, call terminal_wait; a client that supports MCP events can subscribe to terminal.changed instead.";

const CORE_TOOLS = [
  {
    name: "doriterm_tools",
    description:
      `${SEARCH_FIRST} Finds Doriterm tools (terminals, machines, files, docs, the mesh and its devices). Without a query: every tool's name and what it does. ` +
      `With a query: up to ${SEARCH_LIMIT} matching tools with their input schemas. Call one with doriterm_call.`,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Words to match in a tool's name or description." } },
      additionalProperties: false,
    },
  },
  {
    name: "doriterm_call",
    description: `${SEARCH_FIRST} Calls a Doriterm tool found with doriterm_tools, by its name and with its arguments.`,
    inputSchema: {
      type: "object",
      properties: { tool: { type: "string" }, arguments: { type: "object" } },
      required: ["tool"],
      additionalProperties: false,
    },
  },
] as const;

const groupOf = (name: string): string => name.slice(0, name.indexOf("_"));
interface Listed {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}
const listed = ({ name, description, inputSchema }: Listed): Listed => ({ name, description, inputSchema });
/** Every tool a session can call: herdr-core's methods, then this host's mesh tools. */
const CATALOG: readonly Listed[] = [...MCP_TOOLS, ...MESH_TOOLS];

function shownTools(shown: ToolsShown): readonly object[] {
  if (shown === "all") return CATALOG.map(listed);
  if (shown === "core") return CORE_TOOLS;
  return [...CORE_TOOLS, ...CATALOG.filter((row) => shown.includes(groupOf(row.name))).map(listed)];
}

function findTools(query: string | undefined): object {
  if (query === undefined || query.trim() === "") {
    return { tools: CATALOG.map(({ name, description }) => ({ name, description })) };
  }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = CATALOG.filter((row) => {
    const text = `${row.name} ${row.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  return { tools: matches.slice(0, SEARCH_LIMIT).map(listed), more: Math.max(0, matches.length - SEARCH_LIMIT) };
}

/** Reads what the bridge asked to be shown; anything else than "all" or a list of group names means the core two. */
function readShown(params: unknown): ToolsShown {
  const tools = isJsonObject(params) ? params["tools"] : undefined;
  if (tools === "all") return "all";
  if (Array.isArray(tools) && tools.length > 0 && tools.every((group) => typeof group === "string")) return tools;
  return "core";
}

export const toolResult = (value: unknown, isError: boolean) => ({
  resultType: "complete",
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
  isError,
});

/** What one line asks for: an answer now, nothing, a cancellation, what to show from now on, or a tool call to run. */
export type McpLine =
  | { readonly kind: "show"; readonly shown: ToolsShown }
  | { readonly kind: "reply"; readonly reply: object }
  | { readonly kind: "none" }
  | { readonly kind: "cancel"; readonly requestId: unknown }
  | { readonly kind: "call"; readonly id: Id; readonly tool: McpToolRow; readonly args: JsonObject }
  | { readonly kind: "mesh"; readonly id: Id; readonly tool: MeshTool; readonly args: JsonObject }
  | { readonly kind: "resources"; readonly id: Id }
  | { readonly kind: "read"; readonly id: Id; readonly uri: string; readonly address: string }
  | { readonly kind: "listen"; readonly id: string | number; readonly filter: ListenFilter }
  | { readonly kind: "stream"; readonly id: string | number; readonly request: StreamRequest };

export const rpcError = (id: Id, code: number, message: string, data?: object) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, data },
});
const result = (id: Id, value: object): McpLine => ({ kind: "reply", reply: { jsonrpc: "2.0", id, result: value } });
const toolByName = new Map(MCP_TOOLS.map((row) => [row.name, row]));
const meshToolByName = new Map(MESH_TOOLS.map((tool) => [tool.name, tool]));

/** Decodes one complete line without its LF and decides what it asks for; only the methods this host serves exist. */
export function readMcpLine(bytes: Uint8Array, hostVersion: string, shown: ToolsShown = "core"): McpLine {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  if (!isJsonObject(value)) throw new Error("an MCP line must be a JSON object");
  const { jsonrpc, method, id, params } = value;
  if (jsonrpc !== "2.0" || typeof method !== "string")
    return { kind: "reply", reply: rpcError(null, -32600, "Invalid Request") };
  if (id === undefined) {
    if (method === "notifications/cancelled" && isJsonObject(params))
      return { kind: "cancel", requestId: params["requestId"] };
    if (method === TOOLS_SHOWN_METHOD) return { kind: "show", shown: readShown(params) };
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
        capabilities: { tools: {}, resources: { listChanged: true }, extensions: { [EVENTS_EXTENSION]: {} } },
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "doriterm", version: hostVersion } },
        instructions: SERVER_INSTRUCTIONS,
      });
    case "tools/list":
      return result(id, { resultType: "complete", tools: shownTools(shown), ttlMs: 300_000, cacheScope: "private" });
    case "tools/call": {
      const invalid = (what: string): McpLine => ({ kind: "reply", reply: rpcError(id, -32602, what) });
      const given = isJsonObject(params) ? (params["arguments"] ?? {}) : {};
      if (!isJsonObject(given)) return invalid("Invalid params: arguments must be an object");
      const asked = isJsonObject(params) ? params["name"] : undefined;
      if (asked === "doriterm_tools") {
        const query = given["query"];
        if (query !== undefined && typeof query !== "string") return invalid("Invalid params: query must be a string");
        return result(id, toolResult(findTools(query), false));
      }
      // doriterm_call is the same call one level in: the named tool and its arguments.
      const name = asked === "doriterm_call" ? given["tool"] : asked;
      const args = asked === "doriterm_call" ? (given["arguments"] ?? {}) : given;
      if (!isJsonObject(args)) return invalid("Invalid params: arguments must be an object");
      const meshTool = typeof name === "string" ? meshToolByName.get(name) : undefined;
      if (meshTool !== undefined) return { kind: "mesh", id, tool: meshTool, args };
      const tool = typeof name === "string" ? toolByName.get(name) : undefined;
      if (tool === undefined) return invalid(`Unknown tool: ${String(name)}`);
      return { kind: "call", id, tool, args };
    }
    case "resources/list":
      return { kind: "resources", id };
    case "resources/read": {
      const uri = isJsonObject(params) ? params["uri"] : undefined;
      const address = readResourceUri(uri);
      if (typeof uri !== "string" || address === undefined) {
        return { kind: "reply", reply: rpcError(id, -32602, "Resource not found", { uri: uri ?? null }) };
      }
      return { kind: "read", id, uri, address };
    }
    case "subscriptions/listen":
      if (id === null) return { kind: "reply", reply: rpcError(id, -32600, "Invalid Request") };
      return { kind: "listen", id, filter: readListen(params) };
    case "events/list":
      return result(id, { resultType: "complete", events: [EVENT_TYPE] });
    case "events/stream": {
      if (id === null) return { kind: "reply", reply: rpcError(id, -32600, "Invalid Request") };
      const request = readStream(params);
      if ("error" in request)
        return { kind: "reply", reply: rpcError(id, request.error.code, request.error.message, request.error.data) };
      return { kind: "stream", id, request };
    }
    default:
      return { kind: "reply", reply: rpcError(id, -32601, "Method not found") };
  }
}
