import { parseArgs } from "node:util";
import { requestControl } from "../control.ts";
import { defaultStateDir } from "../state/files.ts";
import { grantIdOf, type McpGrant, McpGrantStore } from "../state/mcp-grants.ts";
import { printable } from "./devices.ts";

export const MCP_USAGE = `usage: doriface-host mcp on|off|grants [--state-dir <dir>]
       doriface-host mcp revoke <id> [--state-dir <dir>]
       doriface-host mcp revoke --all [--state-dir <dir>]`;

function line(grant: McpGrant): string {
  const date = new Date(grant.expiresAt);
  const ends = Number.isNaN(date.getTime()) ? `${grant.expiresAt} ms since epoch` : date.toISOString();
  return `${grantIdOf(grant)}  ${grant.kind}  ${ends}  ${printable(grant.name)}\n`;
}

export async function mcpCommand(args: readonly string[], out: (text: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: {
      "state-dir": { type: "string" },
      all: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    out(`${MCP_USAGE}\n`);
    return 0;
  }
  const [action, handle, ...extra] = positionals;
  const stateDir = values["state-dir"] ?? defaultStateDir();
  if (extra.length === 0) {
    if (action === "revoke" && (handle === undefined ? values.all === true : values.all !== true)) {
      const store = new McpGrantStore(stateDir);
      const removed = handle === undefined ? store.revokeAll() : store.revoke(handle);
      if (handle !== undefined && removed.length === 0)
        throw new Error(`no MCP grant has the id ${JSON.stringify(handle)}`);
      await requestControl(stateDir, { op: "mcp-changed" });
      if (removed.length === 0) out("no MCP grants\n");
      for (const grant of removed) out(`revoked ${line(grant)}`);
      return 0;
    }
    if (handle === undefined && values.all !== true) {
      if (action === "on" || action === "off") {
        const store = new McpGrantStore(stateDir);
        store.setEnabled(action === "on");
        if (action === "off") await requestControl(stateDir, { op: "mcp-changed" });
        out(
          action === "on" ? "MCP is on; this host serves clients with live grants\n" : "MCP is off; grants are kept\n",
        );
        return 0;
      }
      if (action === "grants") {
        const store = new McpGrantStore(stateDir);
        if (!store.enabled()) out("MCP is off\n");
        const grants = store.list();
        if (grants.length === 0) out("no MCP grants\n");
        for (const grant of grants) out(line(grant));
        return 0;
      }
    }
  }
  throw new Error(`unknown MCP command: ${positionals.join(" ")}`);
}
