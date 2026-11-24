import { bridgeMethod } from "./bridge.ts";

/** One MCP client connected to this computer now; `name` is null for a mesh client this computer did not pair. */
export interface DesktopMcpClient {
  readonly id: string;
  readonly name: string | null;
}

/** This computer's MCP switch and who is connected through it; `unavailable` says why this app cannot ask its host. */
export type DesktopMcpAnswer =
  | { readonly state: "read"; readonly enabled: boolean; readonly clients: readonly DesktopMcpClient[] }
  | { readonly state: "unavailable"; readonly reason: string };

export type DesktopMcp = (request: "state" | "on" | "off") => Promise<DesktopMcpAnswer>;

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

/** The answer the shell relayed, checked here because the page reads the bridge as an untrusted boundary. */
export function mcpAnswer(value: unknown): DesktopMcpAnswer | undefined {
  const state = field(value, "state");
  if (state === "unavailable") {
    const reason = field(value, "reason");
    return typeof reason === "string" ? { state, reason } : undefined;
  }
  const enabled = field(value, "enabled");
  const list = field(value, "clients");
  if (state !== "read" || typeof enabled !== "boolean" || !Array.isArray(list)) return undefined;
  const clients: DesktopMcpClient[] = [];
  for (const entry of list) {
    const id = field(entry, "id");
    const name = field(entry, "name");
    if (typeof id !== "string" || (name !== null && typeof name !== "string")) return undefined;
    clients.push({ id, name });
  }
  return { state, enabled, clients };
}

/** This computer's MCP switch from the desktop shell; null in a browser or a shell that has no such call. */
export function desktopMcp(scope: object = globalThis): DesktopMcp | null {
  const mcp = bridgeMethod("mcp", scope);
  if (mcp === null) return null;
  return async (request) => {
    const answer = mcpAnswer(await mcp(request));
    if (answer === undefined) throw new Error("the desktop app answered with no MCP state");
    return answer;
  };
}
