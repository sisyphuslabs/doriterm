import type { DesktopMcpAnswer, DesktopMcpClient } from "../desktop/mcp-bridge.ts";

/** What Settings > MCP clients shows for this computer. */
export type McpView =
  | { readonly kind: "asking" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "off" }
  | { readonly kind: "on"; readonly clients: readonly DesktopMcpClient[] };

export function mcpView(answer: DesktopMcpAnswer | null): McpView {
  if (answer === null) return { kind: "asking" };
  if (answer.state === "unavailable") return { kind: "unavailable", reason: answer.reason };
  return answer.enabled ? { kind: "on", clients: answer.clients } : { kind: "off" };
}

/** A client's name on its row and in the dialogs; a mesh client has no device name on this computer. */
export const clientName = (client: DesktopMcpClient): string => client.name ?? "A mesh client";

/** What turning MCP off says it closes; a switch with nothing connected is turned off without asking. */
export function turnOffLine(count: number): string {
  return `${count} ${count === 1 ? "session closes" : "sessions close"}. Paired devices stay paired.`;
}

/** The line an assistant's MCP settings take for this computer. */
export function mcpConfig(hostId: string): string {
  return JSON.stringify(
    { mcpServers: { doriterm: { command: "doriface-host", args: ["connect", "--mcp", hostId] } } },
    null,
    2,
  );
}

/** What pairs the assistant's computer: the same command that later carries MCP, run once with the link. */
export const connectCommand = (link: string): string => `doriface-host connect '${link}'`;
