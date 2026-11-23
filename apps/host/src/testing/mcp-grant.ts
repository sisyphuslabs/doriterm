import { base64urlEncode, generateX25519 } from "@doriface/crypto";
import type { McpGrant } from "../state/mcp-grants.ts";

export const GRANT_EXPIRY = 60_000;

export function mcpGrantFor(publicKey: Uint8Array = generateX25519().publicKey): McpGrant {
  return {
    key: base64urlEncode(publicKey),
    name: "test client",
    kind: "device",
    scopes: { "terminals:read": "allow", exec: "ask" },
    terminals: { kind: "spaces", spaces: ["work"] },
    folders: ["/work"],
    templates: ["shell"],
    confirm: "owner",
    createdAt: "1970-01-01T00:00:00.000Z",
    expiresAt: GRANT_EXPIRY,
    approvedBy: "terminal",
  };
}
