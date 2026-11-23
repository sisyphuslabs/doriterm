import { CloseCode, generateX25519, type SecureLink } from "@doriface/crypto";
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveMcpLines } from "../mcp/serve.ts";
import { MCP_GRANTS_FILE, McpGrantStore } from "../state/mcp-grants.ts";
import { CLIENT, dial, gatewayOn } from "../testing/gateway-harness.ts";
import { removeSides, side } from "../testing/join-harness.ts";
import { GRANT_EXPIRY, mcpGrantFor } from "../testing/mcp-grant.ts";
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

function fixture() {
  const { dir, m: founder } = side("alpha");
  const store = new McpGrantStore(dir);
  store.setEnabled(true);
  let now = GRANT_EXPIRY - 1;
  const gateway = gatewayOn(founder, machine("beta"), {
    dir,
    mcp: { store, now: () => now, serve: (link) => serveMcpLines(link, { hostVersion: "0" }) },
  });
  const key = generateX25519();
  const grant = mcpGrantFor(key.publicKey);
  store.add(grant);

  const connect = async (remote = key, stream: "mcp" | "hc" = "mcp") => {
    const connection = await dial(gateway, remote, founder, undefined, stream);
    clients.push(connection.client);
    return connection;
  };
  const owner = async () => {
    const phone = generateX25519();
    gateway.devices.add(phone.publicKey, "phone");
    return connect(phone, "hc");
  };
  return {
    dir,
    store,
    grant,
    connect,
    owner,
    gateway,
    expire: () => {
      now = GRANT_EXPIRY;
    },
  };
}

async function discover(connection: Connection): Promise<void> {
  connection.send(DISCOVER);
  await connection.answered;
}

async function expectRevoked(connection: Connection): Promise<void> {
  const before = connection.received.length;
  connection.send(DISCOVER);
  await connection.closed;
  expect(connection.hostEnd.closeCode).toBe(CloseCode.UnknownDevice);
  expect(connection.received).toHaveLength(before);
}

test("an MCP session answers discovery over Noise without opening an hc pipe", async () => {
  const { connect, gateway } = fixture();
  const connection = await connect();
  await discover(connection);
  const reply: unknown = JSON.parse(new TextDecoder().decode(connection.received[0]));
  expect(reply).toMatchObject({ id: 1, result: { resultType: "complete", capabilities: {} } });
  expect(gateway.opened()).toBe(0);
});

test("a revoke written by a second store drops the next MCP line and closes with 4401", async () => {
  const { dir, grant, connect } = fixture();
  const connection = await connect();
  await discover(connection);
  new McpGrantStore(dir).revoke(grant.key);
  await expectRevoked(connection);
});

test("switching MCP off drops the next line of an existing session", async () => {
  const { dir, connect } = fixture();
  const connection = await connect();
  new McpGrantStore(dir).setEnabled(false);
  await expectRevoked(connection);
});

test("a session cannot answer the next line once the injected clock reaches expiry", async () => {
  const { connect, expire } = fixture();
  const connection = await connect();
  expire();
  await expectRevoked(connection);
});

test("a corrupt grant file closes MCP while an existing owner's hc line still reaches its pipe", async () => {
  const { dir, connect, owner, gateway } = fixture();
  const hc = await owner();
  const mcp = await connect();
  writeFileSync(join(dir, MCP_GRANTS_FILE), "{");
  await expectRevoked(mcp);
  hc.send(CLIENT);
  await gateway.pipe.reached;
  expect(gateway.pipe.text()).toBe(CLIENT);
  expect(hc.hostEnd.closeCode).toBeUndefined();
});

test("closing revoked sessions after an MCP revoke leaves an existing owner session open", async () => {
  const { connect, owner, grant, store, gateway } = fixture();
  const hc = await owner();
  const mcp = await connect();
  store.revoke(grant.key);
  gateway.sessions.closeRevoked();
  await mcp.closed;
  expect(mcp.hostEnd.closeCode).toBe(CloseCode.UnknownDevice);
  hc.send(CLIENT);
  await gateway.pipe.reached;
  expect(gateway.pipe.text()).toBe(CLIENT);
  expect(hc.hostEnd.closeCode).toBeUndefined();
});

test("an MCP grant's third session is closed with 4429", async () => {
  const { connect } = fixture();
  const first = await connect();
  const second = await connect();
  const third = await connect();
  expect(third.hostEnd.closeCode).toBe(CloseCode.RateLimited);
  await Promise.all([discover(first), discover(second)]);
});

test("a host's ninth MCP session is closed with 4429 even with different keys", async () => {
  const { store, connect } = fixture();
  const newKey = () => {
    const key = generateX25519();
    store.add(mcpGrantFor(key.publicKey));
    return key;
  };
  const keys = Array.from({ length: 8 }, newKey);
  const admitted = await Promise.all(keys.map((key) => connect(key)));
  const ninth = await connect(newKey());
  expect(ninth.hostEnd.closeCode).toBe(CloseCode.RateLimited);
  await Promise.all(admitted.map(discover));
});
