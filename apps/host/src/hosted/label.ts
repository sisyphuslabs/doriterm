export const MCP_DOMAIN = "mcp.doriterm.com";

/** A hostId: base32 of the first 16 bytes of SHA-256 of the host's signing key (hostIdOf), so it is unique per key. */
const HOST_ID = /^[a-z2-7]{26}$/;

/** The host's own name for MCP by URL. It is derived from its key, never chosen, so two hosts cannot share it. */
export function mcpHostname(hostId: string): string {
  if (!HOST_ID.test(hostId)) throw new Error(`not a hostId: ${JSON.stringify(hostId)}`);
  return `${hostId}.${MCP_DOMAIN}`;
}

/** The MCP endpoint a token for this host must name as its audience. */
export const mcpResource = (hostId: string): string => `https://${mcpHostname(hostId)}/mcp`;
