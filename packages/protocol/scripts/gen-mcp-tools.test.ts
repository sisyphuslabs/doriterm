import { expect, test } from "bun:test";
import { SCHEMA_PATH } from "./gen-api.ts";
import { EXCLUDED_METHODS, generateMcpTools, MCP_OUTPUT_PATH } from "./gen-mcp-tools.ts";

test("the committed MCP tool table is what the schema generates, so a hand edit or a schema change fails the check", async () => {
  const generated = await generateMcpTools(await Bun.file(SCHEMA_PATH).text());
  expect(await Bun.file(MCP_OUTPUT_PATH).text()).toBe(generated);
  expect(generated.replace("\n", "")).not.toBe(await Bun.file(MCP_OUTPUT_PATH).text());
});

test("every herdr-core method is a tool except the seven left out, and each input schema is self-contained", async () => {
  const schema = JSON.parse(await Bun.file(SCHEMA_PATH).text());
  const { MCP_TOOLS } = await import("../src/__generated__/mcp-tools.ts");
  const methods: string[] = schema.methods.map((method: { name: string }) => method.name);
  expect(MCP_TOOLS.map((tool): string => tool.method)).toEqual(
    methods.filter((name) => !(EXCLUDED_METHODS as readonly string[]).includes(name)),
  );
  for (const tool of MCP_TOOLS) expect(JSON.stringify(tool.inputSchema)).not.toContain("#/components/");
});
