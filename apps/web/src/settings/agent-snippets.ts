/** Supported AI agents in the order they appear in the connect dialog and docs (OmO first). */
export const AGENTS = ["omo", "claude-code", "codex", "cursor", "other"] as const;

export type AgentId = (typeof AGENTS)[number];

export interface AgentSnippet {
  readonly title: string;
  readonly where: string | null;
  readonly text: string;
}

/**
 * The JSON MCP config shared by OmO, Cursor and other JSON-configured clients, laid out as people write it by hand: the
 * args array on one line, so the block stays short and no token breaks across lines on a phone.
 */
export function mcpConfig(hostId: string): string {
  const args = JSON.stringify(["connect", "--mcp", hostId]).replaceAll(",", ", ");
  return [
    "{",
    '  "mcpServers": {',
    '    "doriterm": {',
    '      "command": "doriface-host",',
    `      "args": ${args}`,
    "    }",
    "  }",
    "}",
  ].join("\n");
}

/** What pairs the assistant's computer: the same command that later carries MCP, run once with the link. */
export const connectCommand = (link: string): string => `doriface-host connect '${link}'`;

/** The manual MCP config or CLI command for one agent targeting `hostId`. */
export function agentSnippet(agent: AgentId, hostId: string): AgentSnippet {
  switch (agent) {
    case "omo":
      return { title: "OmO", where: "~/.omo/agent/mcp.json", text: mcpConfig(hostId) };
    case "claude-code":
      return {
        title: "Claude Code",
        where: null,
        text: `claude mcp add doriterm -- doriface-host connect --mcp ${hostId}`,
      };
    case "codex":
      return {
        title: "Codex",
        where: "~/.codex/config.toml",
        text: `[mcp_servers.doriterm]\ncommand = "doriface-host"\nargs = ["connect", "--mcp", "${hostId}"]`,
      };
    case "cursor":
      return { title: "Cursor", where: ".cursor/mcp.json", text: mcpConfig(hostId) };
    case "other":
      return { title: "Other", where: "its MCP settings", text: mcpConfig(hostId) };
  }
}

/** The one natural-language prompt a person can paste into any agent that can run a command. */
export function agentPrompt(link: string, hostId: string): string {
  return [
    "Connect yourself to my Doriterm. Run these in a terminal on this computer:",
    "1. If doriface-host is not installed: curl -fsSL https://get.doriterm.com | sh -s -- --no-service --no-pair",
    `2. Pair this computer once: ${connectCommand(link)} < /dev/null`,
    `3. Add an MCP server named doriterm to your own MCP settings that runs: doriface-host connect --mcp ${hostId}`,
    "Then tell me it is connected.",
  ].join("\n");
}
