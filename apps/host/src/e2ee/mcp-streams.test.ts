import { base64urlEncode, CloseCode, generateX25519, type SecureLink } from "@doriface/crypto";
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveMcpLines } from "../mcp/serve.ts";
import { DeviceStore } from "../state/devices.ts";
import { MCP_SWITCH_FILE, McpSwitch } from "../state/mcp-switch.ts";
import { CLIENT, dial, gatewayOn } from "../testing/gateway-harness.ts";
import { removeSides, side } from "../testing/join-harness.ts";
import { machine } from "../testing/mesh-history.ts";

type Connection = Awaited<ReturnType<typeof dial>>;
const clients: SecureLink[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  removeSides();
});

const DISCOVER = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "server/discover",
  params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
})}\n`;

function fixture(setting: "on" | "off" | "unset" = "on") {
  const { dir, m: founder } = side("alpha");
  const member = machine("beta");
  const mcp = new McpSwitch(dir);
  if (setting !== "unset") mcp.setEnabled(setting === "on");
  const gateway = gatewayOn(founder, member, {
    dir,
    mcp,
    serveMcp: (link) => serveMcpLines(link, { hostVersion: "0" }),
    push: (link) => link.onData((bytes) => link.send(bytes)),
  });
  const key = generateX25519();
  gateway.devices.add(key.publicKey, "phone");
  const connect = async (stream: "mcp" | "hc" | "push" = "mcp", remote = key) => {
    const connection = await dial(gateway, remote, founder, undefined, stream);
    clients.push(connection.client);
    return connection;
  };
  return { dir, key, member, connect, gateway };
}

async function expectRevoked(connection: Connection): Promise<void> {
  connection.send(DISCOVER);
  await Promise.race([connection.closed, connection.answered]);
  expect(connection.hostEnd.closeCode).toBe(CloseCode.UnknownDevice);
  expect(connection.received).toHaveLength(0);
}

test("a paired device's MCP session answers discovery without opening an hc pipe", async () => {
  const { connect, gateway } = fixture();
  const connection = await connect();
  connection.send(DISCOVER);
  await connection.answered;
  const reply: unknown = JSON.parse(new TextDecoder().decode(connection.received[0]));
  expect(reply).toMatchObject({ id: 1, result: { resultType: "complete", capabilities: { tools: {} } } });
  expect(gateway.opened()).toBe(0);
});

test("a device revoke from a second store closes MCP with 4401 instead of serving the next line", async () => {
  const { dir, key, connect } = fixture();
  const connection = await connect();
  new DeviceStore(dir).revoke(base64urlEncode(key.publicKey));
  await expectRevoked(connection);
});

test("turning MCP off from a second store closes the open session instead of serving the next line", async () => {
  const { dir, connect } = fixture();
  const connection = await connect();
  new McpSwitch(dir).setEnabled(false);
  await expectRevoked(connection);
});

test("a corrupt switch closes MCP without dropping the same device's hc line", async () => {
  const { dir, connect, gateway } = fixture();
  const hc = await connect("hc");
  const mcp = await connect();
  writeFileSync(join(dir, MCP_SWITCH_FILE), "{");
  await expectRevoked(mcp);
  hc.send(CLIENT);
  await Promise.race([gateway.pipe.reached, hc.closed]);
  expect(gateway.pipe.text()).toBe(CLIENT);
  expect(hc.hostEnd.closeCode).toBeUndefined();
});

test("the revocation sweep after switching off closes idle MCP, not the same device's hc or push streams", async () => {
  const { dir, connect, gateway } = fixture();
  const hc = await connect("hc");
  const push = await connect("push");
  const mcp = await connect();
  new McpSwitch(dir).setEnabled(false);
  gateway.sessions.closeRevoked();
  expect(mcp.hostEnd.closeCode).toBe(CloseCode.UnknownDevice);
  expect(hc.hostEnd.closeCode).toBeUndefined();
  expect(push.hostEnd.closeCode).toBeUndefined();
});

test("a machine member's key cannot open MCP even with the switch on", async () => {
  const { connect, member } = fixture();
  await expect(connect("mcp", member.identity.noise)).rejects.toMatchObject({
    code: CloseCode.UnknownDevice,
    cause: { message: "a mesh member has no mcp stream" },
  });
});

test("a paired device's MCP session answers discovery when no switch file exists: MCP is on by default", async () => {
  const { connect } = fixture("unset");
  const connection = await connect();
  connection.send(DISCOVER);
  await connection.answered;
  expect(JSON.parse(new TextDecoder().decode(connection.received[0]))).toMatchObject({ id: 1, result: {} });
});

test("a paired key cannot finish the MCP handshake once MCP was turned off", async () => {
  const { connect } = fixture("off");
  await expect(connect()).rejects.toMatchObject({
    code: CloseCode.UnknownDevice,
    cause: { message: "MCP is off on this host" },
  });
});
