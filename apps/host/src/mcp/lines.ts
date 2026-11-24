import { isJsonObject } from "@doriface/protocol";
import type { SkillFile } from "../skill/bundle-macro.ts";
import { ONE_TOOL, SKILL_URI } from "./one-tool.ts";
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
 * What server/discover tells the model about this server (DiscoverResult.instructions in 2026-07-28): one tool, and the
 * skill that is its manual, so a model reads the skill before it guesses at commands.
 */
export const SERVER_INSTRUCTIONS =
  "Doriterm reaches the terminals, files and mesh of the machine this session is paired with, through one tool, " +
  `doriterm, which runs a Doriterm command the way the hc CLI does. Read ${SKILL_URI} first (resources/read, or ` +
  'call doriterm with args ["skill"]): it is the manual for every command. To wait for a terminal, run ' +
  '["wait","<terminal>"]; a client that supports MCP events can subscribe to terminal.changed instead.';

const SKILL_PREFIX = "doriterm://skill/";
/** The skill this host carries, as MCP resources, under doriterm://skill/<path>. */
export const skillResources = (skill: readonly SkillFile[]): readonly object[] =>
  skill.map((file) => ({
    uri: `${SKILL_PREFIX}${file.path}`,
    name: file.path === "SKILL.md" ? "Doriterm skill" : file.path,
    mimeType: "text/markdown",
  }));
const PROMPT = { name: "doriterm", description: "The Doriterm skill: how to drive terminals, files and the mesh." };

export const toolResult = (value: unknown, isError: boolean) => ({
  resultType: "complete",
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
  isError,
});

/** What one line asks for: an answer now, nothing, a cancellation, or work to run. */
export type McpLine =
  | { readonly kind: "reply"; readonly reply: object }
  | { readonly kind: "none" }
  | { readonly kind: "cancel"; readonly requestId: unknown }
  | {
      readonly kind: "one";
      readonly id: Id;
      readonly args: readonly string[];
      readonly stdin: string | undefined;
      readonly timeoutMs: number;
    }
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

/** Decodes one complete line without its LF and decides what it asks for; only the methods this host serves exist. */
export function readMcpLine(bytes: Uint8Array, hostVersion: string, skill: readonly SkillFile[] = []): McpLine {
  const skillFile = (path: string): SkillFile | undefined => skill.find((file) => file.path === path);
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
        capabilities: {
          tools: {},
          resources: { listChanged: true },
          prompts: {},
          extensions: { [EVENTS_EXTENSION]: {} },
        },
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "doriterm", version: hostVersion } },
        instructions: SERVER_INSTRUCTIONS,
      });
    case "tools/list":
      return result(id, { resultType: "complete", tools: [ONE_TOOL], ttlMs: 300_000, cacheScope: "private" });
    case "tools/call": {
      const invalid = (what: string): McpLine => ({ kind: "reply", reply: rpcError(id, -32602, what) });
      const given = isJsonObject(params) ? (params["arguments"] ?? {}) : {};
      if (!isJsonObject(given)) return invalid("Invalid params: arguments must be an object");
      const asked = isJsonObject(params) ? params["name"] : undefined;
      if (asked !== ONE_TOOL.name) return invalid(`Unknown tool: ${String(asked)}`);
      const { args, stdin, timeoutSeconds } = given;
      if (!Array.isArray(args) || !args.every((word): word is string => typeof word === "string")) {
        return invalid("Invalid params: args must be a list of strings");
      }
      if (stdin !== undefined && typeof stdin !== "string") return invalid("Invalid params: stdin must be a string");
      const seconds = timeoutSeconds ?? 60;
      if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1 || seconds > 600) {
        return invalid("Invalid params: timeoutSeconds must be a whole number from 1 to 600");
      }
      return { kind: "one", id, args, stdin, timeoutMs: seconds * 1000 };
    }
    case "prompts/list":
      return result(id, { resultType: "complete", prompts: [PROMPT] });
    case "prompts/get": {
      if (!isJsonObject(params) || params["name"] !== PROMPT.name) {
        return { kind: "reply", reply: rpcError(id, -32602, "Prompt not found") };
      }
      const text = skillFile("SKILL.md")?.text ?? "";
      return result(id, {
        resultType: "complete",
        description: PROMPT.description,
        messages: [{ role: "user", content: { type: "text", text } }],
      });
    }
    case "resources/list":
      return { kind: "resources", id };
    case "resources/read": {
      const uri = isJsonObject(params) ? params["uri"] : undefined;
      if (typeof uri === "string" && uri.startsWith(SKILL_PREFIX)) {
        const file = skillFile(uri.slice(SKILL_PREFIX.length));
        if (file === undefined) return { kind: "reply", reply: rpcError(id, -32602, "Resource not found", { uri }) };
        const contents = [{ uri, mimeType: "text/markdown", text: file.text }];
        return result(id, { resultType: "complete", contents, ttlMs: 300_000, cacheScope: "private" });
      }
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
