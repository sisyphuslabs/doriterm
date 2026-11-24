import type { JsonWebKey } from "node:crypto";
import { appendFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { PushLink } from "../push/push-stream.ts";
import { isRecord, readJson } from "../state/files.ts";
import { type AuditLine, hostedMcp } from "./http.ts";
import { mcpResource } from "./label.ts";

export const HOSTED_AGENTS_FILE = "hosted-agents.json";
export const HOSTED_KEYS_FILE = "hosted-jwks.json";
export const HOSTED_AUDIT_FILE = "hosted-audit.jsonl";
const DEFAULT_ISSUER = "https://doriterm.com";
const PER_MINUTE = 120;

type Jwk = JsonWebKey & { readonly kid?: string };

/** The agents the person approved: `{"version":1,"agents":{"<id>":{"name":"…","scopes":["read"]}}}`; none when absent. */
export function approvedAgent(stateDir: string, id: string) {
  const file = readJson(join(stateDir, HOSTED_AGENTS_FILE));
  const agents = isRecord(file) && file["version"] === 1 ? file["agents"] : undefined;
  const agent = isRecord(agents) ? agents[id] : undefined;
  if (!isRecord(agent) || typeof agent["name"] !== "string" || !Array.isArray(agent["scopes"])) return undefined;
  return { name: agent["name"], scopes: agent["scopes"].filter((scope): scope is string => typeof scope === "string") };
}

/** The issuer's public keys as a JWKS file the host keeps; none when absent, so every token is refused. */
export function issuerKeys(stateDir: string): readonly Jwk[] {
  const file = readJson(join(stateDir, HOSTED_KEYS_FILE));
  const keys = isRecord(file) ? file["keys"] : undefined;
  return Array.isArray(keys) ? keys.filter((key): key is Jwk => isRecord(key)) : [];
}

/** Appends one audited call to the owner-only audit file. */
export function appendAudit(stateDir: string, line: AuditLine): void {
  const path = join(stateDir, HOSTED_AUDIT_FILE);
  appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface HostedSetup {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stateDir: string;
  readonly hostId: string;
  readonly serve: (link: PushLink) => void;
  /** The host's MCP switch: the URL endpoint is off whenever MCP is. */
  readonly mcpOn: () => boolean;
}

/** The URL endpoint when DORIFACE_HOSTED_MCP=1, at the host's own name unless DORIFACE_HOSTED_MCP_URL overrides it. */
export function hostedFromEnv({ env, stateDir, hostId, serve, mcpOn }: HostedSetup) {
  if (env["DORIFACE_HOSTED_MCP"] !== "1") return undefined;
  const resource = env["DORIFACE_HOSTED_MCP_URL"] || mcpResource(hostId);
  const handle = hostedMcp({
    resource,
    issuer: env["DORIFACE_HOSTED_MCP_ISSUER"] ?? DEFAULT_ISSUER,
    keys: () => issuerKeys(stateDir),
    agents: (id) => approvedAgent(stateDir, id),
    allowedOrigins: [],
    perMinute: PER_MINUTE,
    now: () => Date.now(),
    audit: (line) => appendAudit(stateDir, line),
    serve,
  });
  return (request: Request): Promise<Response> =>
    mcpOn() ? handle(request) : Promise.resolve(Response.json({ error: "MCP is off on this host" }, { status: 403 }));
}
