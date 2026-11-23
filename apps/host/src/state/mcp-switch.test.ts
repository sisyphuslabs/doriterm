import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_SWITCH_FILE, McpSwitch } from "./mcp-switch.ts";

let dir: string;
let file: string;
let mcp: McpSwitch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dh-mcp-switch-"));
  file = join(dir, MCP_SWITCH_FILE);
  mcp = new McpSwitch(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a missing switch is off, not implicitly enabled", () => {
  expect(mcp.enabled()).toBe(false);
});

test("both switch settings persist across readers", () => {
  mcp.setEnabled(true);
  expect(new McpSwitch(dir).enabled()).toBe(true);
  mcp.setEnabled(false);
  expect(new McpSwitch(dir).enabled()).toBe(false);
});

test("a second writer invalidates a reader's cached switch", () => {
  mcp.setEnabled(true);
  expect(mcp.enabled()).toBe(true);
  new McpSwitch(dir).setEnabled(false);
  expect(mcp.enabled()).toBe(false);
});

test.each([
  ["invalid JSON", "{"],
  ["a non-object", "null"],
  ["a different version", '{"version":2,"enabled":true}'],
  ["an unknown key", '{"version":1,"enabled":true,"extra":0}'],
  ["a non-boolean setting", '{"version":1,"enabled":"true"}'],
  ["a missing setting", '{"version":1}'],
])("rejects %s instead of accepting a malformed switch", (_, contents) => {
  writeFileSync(file, contents);
  expect(() => mcp.enabled()).toThrow(MCP_SWITCH_FILE);
});

test("an unreadable switch is not treated as a missing file", () => {
  mkdirSync(file);
  expect(() => mcp.enabled()).toThrow(MCP_SWITCH_FILE);
});

test("writing the switch replaces corrupt contents", () => {
  writeFileSync(file, "{");
  mcp.setEnabled(true);
  expect(new McpSwitch(dir).enabled()).toBe(true);
});

test.skipIf(process.platform === "win32")("the switch is written owner-only, mode 0600", () => {
  mcp.setEnabled(true);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});
