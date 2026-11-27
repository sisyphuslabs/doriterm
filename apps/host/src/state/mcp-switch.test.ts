import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

test("a missing switch is off: MCP waits for the owner to turn it on", () => {
  expect(mcp.enabled()).toBe(false);
});

const quiet = (): void => {};

test("a host's first start settles a missing switch once: on where someone could already use MCP, off otherwise", () => {
  mcp.settleUnset(() => true, quiet);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, enabled: true });

  const fresh = mkdtempSync(join(tmpdir(), "dh-mcp-switch-fresh-"));
  try {
    new McpSwitch(fresh).settleUnset(() => false, quiet);
    expect(JSON.parse(readFileSync(join(fresh, MCP_SWITCH_FILE), "utf8"))).toEqual({ version: 1, enabled: false });
    // A device paired later does not turn it on at the next start: the setting is explicit now.
    new McpSwitch(fresh).settleUnset(() => true, quiet);
    expect(new McpSwitch(fresh).enabled()).toBe(false);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

test("settling never changes a setting the owner wrote", () => {
  mcp.setEnabled(false);
  mcp.settleUnset(() => true, quiet);
  expect(mcp.enabled()).toBe(false);
  mcp.setEnabled(true);
  mcp.settleUnset(() => false, quiet);
  expect(mcp.enabled()).toBe(true);
});

test("when who uses the host cannot be read, MCP stays off, the reason is logged, and the next start settles it", () => {
  const logged: string[] = [];
  mcp.settleUnset(
    () => {
      throw new Error("devices.json: unsupported format");
    },
    (line) => logged.push(line),
  );
  expect(existsSync(file)).toBe(false);
  expect(mcp.enabled()).toBe(false);
  expect(logged).toEqual([
    "mcp: cannot read who uses this host (Error: devices.json: unsupported format); MCP stays off until the next start settles it",
  ]);
  mcp.settleUnset(() => true, quiet);
  expect(mcp.enabled()).toBe(true);
});

test("an explicit off outlives the process that wrote it, as it does across an update", () => {
  mcp.setEnabled(false);
  expect(new McpSwitch(dir).enabled()).toBe(false);
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
