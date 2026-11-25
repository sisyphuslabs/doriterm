import { base64urlEncode, fingerprintOf, generateX25519 } from "@doriface/crypto";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlListener, listenControl } from "../control.ts";
import { deviceIdOf, DeviceStore } from "../state/devices.ts";
import { McpSwitch } from "../state/mcp-switch.ts";

const CLI = join(import.meta.dir, "..", "cli.ts");
let dir: string;
let store: McpSwitch;
const listeners: ControlListener[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dh-mcp-"));
  store = new McpSwitch(dir);
});
afterEach(() => {
  for (const listener of listeners.splice(0)) listener.stop();
  rmSync(dir, { recursive: true, force: true });
});

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
  expect(result.stdout).toBe("MCP is on: a paired device may open an MCP session on this machine\n");
  expect(store.enabled()).toBe(true);
});

test("mcp off notifies the host after disabling MCP without unpairing devices", async () => {
  store.setEnabled(true);
  const devices = new DeviceStore(dir);
  const phone = devices.add(generateX25519().publicKey, "phone");
  const notifications: unknown[] = [];
  listeners.push(
    listenControl(dir, (request) => {
      notifications.push({ op: request.op, enabled: store.enabled() });
      return Promise.resolve(null);
    }),
  );

  const result = await mcp("off");
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("MCP is off: its sessions are closed, and paired devices stay paired\n");
  expect(notifications).toEqual([{ op: "mcp-changed", enabled: false }]);
  expect(devices.list()).toEqual([phone]);
});

test("status reports MCP on by default and distinguishes a running host with no sessions", async () => {
  listeners.push(
    listenControl(dir, (request) => {
      if (request.op !== "mcp-status") throw new Error("expected mcp-status");
      return Promise.resolve({ sessions: [] });
    }),
  );
  const result = await mcp("status");
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("MCP is on\nno MCP client is connected\n");
});

test("status reports MCP on even when the host is not running", async () => {
  store.setEnabled(true);
  const result = await mcp("status");
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("MCP is on\nthe host is not running\n");
});

test("status prints each connected session with an escaped device name or a mesh client label", async () => {
  store.setEnabled(true);
  const devices = new DeviceStore(dir);
  const phone = devices.add(generateX25519().publicKey, "two\nlines");
  const meshClient = generateX25519().publicKey;
  listeners.push(
    listenControl(dir, (request) => {
      if (request.op !== "mcp-status") throw new Error("expected mcp-status");
      return Promise.resolve({ sessions: [{ key: phone.clientStaticPub }, { key: base64urlEncode(meshClient) }] });
    }),
  );

  const result = await mcp("status");
  expect(result.code).toBe(0);
  const meshId = fingerprintOf(meshClient).split(" ").slice(0, 2).join("");
  expect(result.stdout).toBe(`MCP is on\n${deviceIdOf(phone)}  two\\u000alines\n${meshId}  (mesh client)\n`);
});

test("mcp rejects a removed grant subcommand instead of reporting success", async () => {
  const result = await mcp("grants");
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("unknown MCP command: grants");
  expect(result.stdout).toBe("");
});
