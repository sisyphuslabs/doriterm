import { expect, test } from "bun:test";
import { AGENTS, agentPrompt, agentSnippet } from "./agent-snippets.ts";

test("AGENTS lists supported agents with OmO first", () => {
  expect(AGENTS).toEqual(["omo", "claude-code", "codex", "cursor", "other"]);
});

test("agentSnippet returns exact titles, locations and texts for each agent", () => {
  const hostId = "h4xq9k2m";
  const config = { mcpServers: { doriterm: { command: "doriface-host", args: ["connect", "--mcp", hostId] } } };
  // The JSON agents read it as an object: its layout is free, what it parses to is not.
  for (const agent of ["omo", "cursor", "other"] as const) {
    expect(JSON.parse(agentSnippet(agent, hostId).text)).toEqual(config);
  }
  const expectedJson = agentSnippet("other", hostId).text;

  expect(agentSnippet("omo", hostId)).toEqual({
    title: "OmO",
    where: "~/.omo/agent/mcp.json",
    text: expectedJson,
  });
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
  expect(agentSnippet("cursor", hostId)).toEqual({
    title: "Cursor",
    where: ".cursor/mcp.json",
    text: expectedJson,
  });
  expect(agentSnippet("other", hostId)).toEqual({
    title: "Other",
    where: "its MCP settings",
    text: expectedJson,
  });
});

test("agentPrompt produces the exact natural-language prompt with link and hostId", () => {
  const link = "doriface://pair#p=abc123";
  const hostId = "h4xq9k2m";
  expect(agentPrompt(link, hostId)).toBe(
    "Connect yourself to my Doriterm. Run these in a terminal on this computer:\n" +
      "1. If doriface-host is not installed: curl -fsSL https://get.doriterm.com | sh -s -- --no-service --no-pair\n" +
      `2. Pair this computer once: doriface-host connect '${link}' < /dev/null\n` +
      `3. Add an MCP server named doriterm to your own MCP settings that runs: doriface-host connect --mcp ${hostId}\n` +
      "Then tell me it is connected.",
  );
});
