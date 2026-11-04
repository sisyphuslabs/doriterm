import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import packageJson from "../package.json" with { type: "json" };
import { generateToken, SUBPROTOCOL } from "./auth.ts";
import { type Host, startHost } from "./host.ts";
import { createHcSession, HELLO, type HcSession, rpcFrame } from "./testing/hc-session.ts";
import { openWsClient } from "./testing/ws-client.ts";

const decoder = new TextDecoder();
const logs: string[] = [];
let session: HcSession;
let host: Host;
const token = generateToken();

/** Live `hc connect` processes for a session, read from full argv (pgrep -l prints only the name on Linux). */
const hcConnectsOf = (name: string): string[] =>
  Bun.spawnSync(["ps", "-axo", "pid=,args="], { stdout: "pipe" })
    .stdout.toString()
    .split("\n")
    .filter((line) => line.includes(" connect ") && line.includes(name));

beforeAll(async () => {
  session = createHcSession("doriface-host-test");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token,
    hc: session.hc,
    session: session.name,
    env: session.env,
    log: (line) => logs.push(line),
  });
});

afterAll(async () => {
  await host.stop();
  await session.dispose();
});

describe("doriface-host against a real hc", () => {
  test("healthz reports both versions", async () => {
    const res = await fetch(`http://127.0.0.1:${host.port}/healthz`);
    const version = Bun.spawnSync([session.hc, "--version"]).stdout.toString().trim();
    expect(await res.json()).toEqual({
      ok: true,
      hostVersion: packageJson.version,
      hcVersion: version.replace(/^hc /, ""),
    });
  });

  test("a wrong token is refused before the upgrade", async () => {
    const res = await fetch(`http://127.0.0.1:${host.port}/v1/hc`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
        "sec-websocket-protocol": `${SUBPROTOCOL}, doriface.token.${generateToken()}`,
      },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("upgrade")).toBeNull();
  });

  test("replies through the host are byte-identical to a direct hc connect", async () => {
    const client = await openWsClient(host.url, token);
    expect(client.socket.protocol).toBe(SUBPROTOCOL);
    client.socket.send(HELLO);
    const helloViaHost = await client.reader.line();
    client.socket.send(rpcFrame(1, "terminal.list"));
    const listViaHost = await client.reader.frame();

    const direct = session.connect();
    await direct.write(HELLO);
    const helloDirect = await direct.reader.line();
    await direct.write(rpcFrame(1, "terminal.list"));
    const listDirect = await direct.reader.frame();
    direct.end();
    await direct.exited;

    expect(JSON.parse(decoder.decode(helloViaHost)).result.framed).toBe(true);
    expect(JSON.parse(decoder.decode(listViaHost.subarray(9)))).toMatchObject({ id: 1, result: {} });
    expect(helloViaHost).toEqual(helloDirect);
    expect(listViaHost).toEqual(listDirect);
    console.log(
      `byte-identical: hello reply ${helloViaHost.byteLength} B, terminal.list frame ${listViaHost.byteLength} B`,
    );

    // This client's own child, and the one the host watches its core over (it removes Ended terminals).
    expect(hcConnectsOf(session.name)).toHaveLength(2);
    client.socket.close();
  });

  test("stop closes every hc connect child", async () => {
    const client = await openWsClient(host.url, token);
    client.socket.send(HELLO);
    await client.reader.line();
    // The previous test's child may still be exiting, so only require that one is alive.
    expect(hcConnectsOf(session.name).length).toBeGreaterThan(0);
    await host.stop();
    expect(hcConnectsOf(session.name)).toEqual([]);
    await expect(client.reader.line()).rejects.toThrow("stream ended");
  });
});
