import { isMcpClient, type LocalHostEndpoint, type McpAnswer, type McpRequest } from "../shared/bridge.ts";

const DEFAULT_TIMEOUT_MS = 10_000;

/** The loopback gateway answers plain HTTP on the same port as its websocket; `/v1/mcp` sits beside `/v1/devices`. */
export function mcpEndpointUrl(endpoint: LocalHostEndpoint): string {
  const url = new URL(endpoint.url);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/v1/mcp";
  url.search = "";
  return url.toString();
}

const unavailable = (reason: string): McpAnswer => ({ state: "unavailable", reason });

function refusal(status: number): string | undefined {
  if (status === 404) return "This doriface-host is too old to accept MCP clients.";
  if (status === 401) return "This computer's host refused the request; start it again.";
  return status >= 400 ? `This computer's host answered ${status}.` : undefined;
}

/**
 * Reads or sets this computer's MCP switch over the token-guarded loopback gateway. The host is another process whose
 * answer is untrusted: every field is checked, and every failure is a value Settings can say out loud.
 */
export async function requestMcp(
  endpoint: LocalHostEndpoint,
  request: McpRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<McpAnswer> {
  let response: Response;
  try {
    response = await fetch(mcpEndpointUrl(endpoint), {
      headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      ...(request === "state" ? {} : { method: "PUT", body: JSON.stringify({ enabled: request === "on" }) }),
    });
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  const refused = refusal(response.status);
  if (refused !== undefined) return unavailable(refused);
  const body: unknown = await response.json().catch(() => null);
  const enabled: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "enabled") : undefined;
  const clients: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "clients") : undefined;
  if (typeof enabled !== "boolean" || !Array.isArray(clients) || !clients.every(isMcpClient)) {
    return unavailable("This computer's host sent an MCP answer this app does not understand.");
  }
  return { state: "read", enabled, clients: clients.map(({ id, name }) => ({ id, name })) };
}
