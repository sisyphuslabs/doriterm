import { expect, test } from "bun:test";
import { AGENTS, OMO_MCP_FILE, agentPrompt, agentSnippet } from "./agent-snippets.ts";

const hostId = "h4xq9k2m";
const link = "doriface://pair#p=abc123";

test("the agents set up by hand, in order: Claude Code, Codex, Cursor, then any other", () => {
  expect(AGENTS).toEqual(["claude-code", "codex", "cursor", "other"]);
});

test("each by-hand snippet is what that agent reads", () => {
  const config = { mcpServers: { doriterm: { command: "doriface-host", args: ["connect", "--mcp", hostId] } } };
  // The JSON agents read it as an object: its layout is free, what it parses to is not.
  for (const agent of ["cursor", "other"] as const) {
    expect(JSON.parse(agentSnippet(agent, hostId).text)).toEqual(config);
  }
  expect(agentSnippet("claude-code", hostId)).toEqual({
    title: "Claude Code",
    where: null,
    text: `claude mcp add doriterm -- doriface-host connect --mcp ${hostId}`,
  });
  expect(agentSnippet("codex", hostId)).toEqual({
    title: "Codex",
    where: "~/.codex/config.toml",
    text: `[mcp_servers.doriterm]\ncommand = "doriface-host"\nargs = ["connect", "--mcp", "${hostId}"]`,
  });
  expect([agentSnippet("cursor", hostId).where, agentSnippet("other", hostId).where]).toEqual([
    ".cursor/mcp.json",
    "its MCP settings",
  ]);
});

test("the prompt installs without a service, pairs once with the link and adds the server by host id", () => {
  expect(agentPrompt(link, hostId)).toBe(
    "Connect yourself to my Doriterm. Run these in a terminal on this computer:\n" +
      "1. If doriface-host is not installed: curl -fsSL https://get.doriterm.com | sh -s -- --no-service --no-pair\n" +
      `2. Pair this computer once: doriface-host connect '${link}' < /dev/null\n` +
      `3. Add an MCP server named doriterm to your own MCP settings that runs: doriface-host connect --mcp ${hostId}\n` +
      "Then tell me it is connected.",
  );
});

test("OmO's prompt names OmO's own MCP settings file, and says the rest as any agent's does", () => {
  const omo = agentPrompt(link, hostId, "omo");
  expect(omo).toContain(`3. Add an MCP server named doriterm to ${OMO_MCP_FILE} that runs:`);
  expect(omo.replace(OMO_MCP_FILE, "your own MCP settings")).toBe(agentPrompt(link, hostId));
});
