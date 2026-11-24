import { isJsonObject } from "@doriface/protocol";

export const SCOPES = ["read", "act", "mesh"] as const;
export type Scope = (typeof SCOPES)[number];

const READ_TOOL = /_(list|get|read|wait|status|stat|glob|grep|read_bytes)$/;
const READ_NAMES: ReadonlySet<string> = new Set(["doriterm_tools", "doc_get", "templates_list"]);

/** The scope a tool needs: mesh for the mesh tools, read for the ones that only look, act for the rest. */
export function toolScope(name: string): Scope {
  if (name.startsWith("mesh_")) return "mesh";
  if (READ_NAMES.has(name) || READ_TOOL.test(name)) return "read";
  return "act";
}

/** The tool a tools/call runs: doriterm_call's inner tool, so the wrapper never widens what an agent may do. */
export function calledTool(params: unknown): string | undefined {
  if (!isJsonObject(params)) return undefined;
  const name = params["name"];
  if (name !== "doriterm_call") return typeof name === "string" ? name : undefined;
  const args = params["arguments"];
  const inner = isJsonObject(args) ? args["tool"] : undefined;
  return typeof inner === "string" ? inner : undefined;
}

/** What a request needs: only tools/call can change anything; discovery, lists, reads and subscriptions are read. */
export function requestScope(method: string, params: unknown): Scope {
  if (method !== "tools/call") return "read";
  const tool = calledTool(params);
  return tool === undefined ? "read" : toolScope(tool);
}
