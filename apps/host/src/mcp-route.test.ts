import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateX25519 } from "@doriface/crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "./auth.ts";
import { type Host, startHost } from "./host.ts";
import { McpSurface } from "./mcp-surface.ts";
import { DeviceStore, deviceIdOf } from "./state/devices.ts";
import { MCP_SWITCH_FILE, McpSwitch } from "./state/mcp-switch.ts";
import { createHcSession, type HcSession } from "./testing/hc-session.ts";

const token = generateToken();
let session: HcSession;
let host: Host;
let stateDir: string;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "dh-mcp-route-"));
  session = createHcSession("doriface-mcp-route-test");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    // The LAN listener serves /healthz and /v1/e2ee only: the MCP routes must not appear on it.
    lanListen: { hostname: "127.0.0.1", port: 0 },
    token,
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir,
    log: () => {},
  });
});

afterEach(async () => {
  await host.stop();
  await session.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

const request = (
  method: "GET" | "PUT",
  body?: unknown,
  auth: string | null = `Bearer ${token}`,
  origin = `http://127.0.0.1:${host.port}`,
) =>
  fetch(`${origin}/v1/mcp`, {
    method,
    headers: { ...(auth === null ? {} : { authorization: auth }), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

test("a fresh host's first start writes MCP off, and a host with paired devices keeps serving them", async () => {
  expect(JSON.parse(readFileSync(join(stateDir, MCP_SWITCH_FILE), "utf8"))).toEqual({ version: 1, enabled: false });

  const paired = mkdtempSync(join(tmpdir(), "dh-mcp-route-paired-"));
  new DeviceStore(paired).add(generateX25519().publicKey, "assistant");
  const upgraded = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token,
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir: paired,
    log: () => {},
  });
  try {
    expect(new McpSwitch(paired).enabled()).toBe(true);
  } finally {
    await upgraded.stop();
    rmSync(paired, { recursive: true, force: true });
  }
});

test("without the host's token the switch is neither read nor set, and it stays off", async () => {
  expect((await request("GET", undefined, null)).status).toBe(401);
  expect((await request("PUT", { enabled: true }, "Bearer wrong-token-wrong-token-xxx")).status).toBe(401);
  expect(new McpSwitch(stateDir).enabled()).toBe(false);
});

test("the LAN listener has no MCP route, even with the token", async () => {
  const lan = host.e2ee?.lanUrls[0];
  if (lan === undefined) throw new Error("the host started no LAN listener");
  const origin = lan.replace(/^ws/, "http").replace(/\/v1\/e2ee$/, "");
  expect((await request("GET", undefined, `Bearer ${token}`, origin)).status).toBe(404);
  expect((await request("PUT", { enabled: true }, `Bearer ${token}`, origin)).status).toBe(404);
  expect(new McpSwitch(stateDir).enabled()).toBe(false);
});

test("MCP is off until it is set on, and what is set is what the terminal command reads", async () => {
  expect(await (await request("GET")).json()).toEqual({ enabled: false, clients: [] });
  expect(await (await request("PUT", { enabled: true })).json()).toEqual({ enabled: true, clients: [] });
  expect(new McpSwitch(stateDir).enabled()).toBe(true);
  expect(await (await request("PUT", { enabled: false })).json()).toEqual({ enabled: false, clients: [] });
  expect(new McpSwitch(stateDir).enabled()).toBe(false);
});

test("a body that names no true or false is refused and changes nothing", async () => {
  const answers = await Promise.all([{ enabled: "true" }, {}, "not json", [true]].map((body) => request("PUT", body)));
  expect(answers.map((answer) => answer.status)).toEqual([400, 400, 400, 400]);
  expect(await answers[0]?.json()).toEqual({ error: "enabled must be true or false" });
  expect(new McpSwitch(stateDir).enabled()).toBe(false);
});

test("a connected client reads as its paired device, a key no device has as a mesh client, and off closes sessions", async () => {
  const devices = new DeviceStore(stateDir);
  const device = devices.add(generateX25519().publicKey, "assistant");
  let closed = 0;
  const surface = new McpSurface({
    mcp: new McpSwitch(stateDir),
    devices,
    sessions: () => [
      { key: device.clientStaticPub },
      { key: device.clientStaticPub.replace(/^./, (c) => (c === "A" ? "B" : "A")) },
    ],
    changed: async () => {
      closed += 1;
    },
  });
  const { clients } = await surface.set(true);
  expect(closed).toBe(0);
  expect(clients[0]).toEqual({ id: deviceIdOf(device), name: "assistant" });
  expect(clients[1]?.name).toBeNull();
  expect(clients[1]?.id).toMatch(/^[0-9A-Z]{8}$/);
  expect((await surface.set(false)).enabled).toBe(false);
  expect(closed).toBe(1);
});
