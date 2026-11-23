import { base64urlDecode, fingerprintOf } from "@doriface/crypto";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenControl } from "../control.ts";
import { McpGrantStore } from "../state/mcp-grants.ts";
import { mcpGrantFor } from "../testing/mcp-grant.ts";

const CLI = join(import.meta.dir, "..", "cli.ts");
let dir: string;
let store: McpGrantStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dh-mcp-"));
  store = new McpGrantStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function mcp(...args: readonly string[]) {
  const child = Bun.spawn([process.execPath, CLI, "mcp", ...args, "--state-dir", dir], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

test("mcp on enables the requested state directory", async () => {
  const result = await mcp("on");
  expect(result.code).toBe(0);
  expect(result.stdout.split("\n")).toEqual([expect.stringContaining("MCP is on"), ""]);
  expect(store.enabled()).toBe(true);
});

test("mcp off keeps grants and notifies the running host after writing", async () => {
  const grant = mcpGrantFor();
  store.add(grant);
  store.setEnabled(true);
  const notifications: unknown[] = [];
  const control = listenControl(dir, async (request) => {
    notifications.push({ op: request.op, enabled: store.enabled() });
    return null;
  });
  try {
    const result = await mcp("off");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("grants are kept");
    expect(store.list()).toEqual([grant]);
    expect(notifications).toEqual([{ op: "mcp-changed", enabled: false }]);
  } finally {
    control.stop();
  }
});

test("mcp grants shows that MCP is off and there are no grants by default", async () => {
  const result = await mcp("grants");
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("MCP is off\nno MCP grants\n");
});

test("mcp grants prints the expiry and escapes control characters in names", async () => {
  const grant = { ...mcpGrantFor(), name: "two\nlines", kind: "session" as const };
  store.setEnabled(true);
  store.add(grant);
  const result = await mcp("grants");
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(/^[0-9A-F]{8}  session  1970-01-01T00:01:00\.000Z  two\\u000alines\n$/);
});

test("mcp revoke burns only the selected id and notifies the running host after writing", async () => {
  const grant = mcpGrantFor();
  const other = mcpGrantFor();
  store.add(grant);
  store.add(other);
  const id = fingerprintOf(base64urlDecode(grant.key)).replaceAll(" ", "").slice(0, 8);
  const notifications: unknown[] = [];
  const control = listenControl(dir, async (request) => {
    notifications.push({ op: request.op, grants: store.list().length });
    return null;
  });
  try {
    const result = await mcp("revoke", id);
    expect(result.code).toBe(0);
    expect(store.list()).toEqual([other]);
    expect(store.holds(grant.key)).toBe(true);
    expect(notifications).toEqual([{ op: "mcp-changed", grants: 1 }]);
  } finally {
    control.stop();
  }
});

test("mcp revoke --all burns all listed grants", async () => {
  const first = mcpGrantFor();
  const second = mcpGrantFor();
  store.add(first);
  store.add(second);
  expect((await mcp("revoke", "--all")).code).toBe(0);
  expect(store.list()).toEqual([]);
  expect(store.holds(first.key)).toBe(true);
  expect(store.holds(second.key)).toBe(true);
});

test("mcp revoke fails for an unknown id instead of reporting success", async () => {
  const result = await mcp("revoke", "DEADBEEF");
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("DEADBEEF");
  expect(result.stdout).toBe("");
});
