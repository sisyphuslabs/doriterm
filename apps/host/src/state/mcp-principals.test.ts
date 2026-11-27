import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearClientSessions, clients } from "../testing/client-session-harness.ts";
import { DeviceStore } from "./devices.ts";
import { hasMcpPrincipals, McpSwitch } from "./mcp-switch.ts";
import { MeshStore } from "./mesh.ts";

afterEach(clearClientSessions);

test("an upgraded host whose only users are mesh client members keeps MCP on", () => {
  const f = clients();
  const devices = new DeviceStore(f.a.dir);
  expect(devices.list()).toEqual([]);
  expect(f.a.mesh.authorizeIndex()?.clients().length).toBe(2);

  const mcp = new McpSwitch(f.a.dir);
  mcp.settleUnset(
    () => hasMcpPrincipals(devices, f.a.mesh),
    () => {},
  );
  expect(mcp.enabled()).toBe(true);
});

test("a host with no paired device and no mesh has no one to keep MCP on for", () => {
  const dir = mkdtempSync(join(tmpdir(), "dh-mcp-principals-"));
  try {
    expect(hasMcpPrincipals(new DeviceStore(dir), new MeshStore(dir, { log: () => {} }))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
