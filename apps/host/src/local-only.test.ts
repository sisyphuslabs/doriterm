import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { DEFAULT_PUSH_PREFS } from "@doriface/protocol";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken, SUBPROTOCOL } from "./auth.ts";
import { requestControl } from "./control.ts";
import { type Host, startHost } from "./host.ts";
import { LOCAL_ONLY_PUSH } from "./push/host-push.ts";
import { createHcSession, type HcSession } from "./testing/hc-session.ts";

const CLI = join(import.meta.dir, "cli.ts");
const token = generateToken();
const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Every socket or request this process opens to anything but this computer, while the spies are in. */
const dialed: string[] = [];
const realFetch = globalThis.fetch;
const RealWebSocket = globalThis.WebSocket;
const outside = (url: string | URL): boolean => !LOCAL.has(new URL(url).hostname);

beforeAll(() => {
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input;
      if (outside(url)) dialed.push(String(url));
      return realFetch(input, init);
    },
    { preconnect: realFetch.preconnect },
  );
  globalThis.WebSocket = new Proxy(RealWebSocket, {
    construct(target, args: ConstructorParameters<typeof RealWebSocket>) {
      if (outside(args[0])) dialed.push(String(args[0]));
      return Reflect.construct(target, args);
    },
  });
});
afterAll(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = RealWebSocket;
});

let session: HcSession;
let host: Host;
let stateDir: string;

beforeEach(async () => {
  dialed.length = 0;
  stateDir = mkdtempSync(join(tmpdir(), "dh-local-only-"));
  session = createHcSession("doriface-local-only-test");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token,
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir,
    localOnly: true,
    log: () => {},
  });
});

afterEach(async () => {
  await host.stop();
  await session.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

const REFUSAL = "this host runs local-only";

test("a local-only host keeps no relay uplink and opens no pairing or mesh offer, so it never dials out", async () => {
  expect(host.relayUrl).toBeUndefined();

  const offer = await realFetch(`http://127.0.0.1:${host.port}/v1/pair`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(offer.status).toBe(409);
  expect(((await offer.json()) as { error: string }).error).toContain(REFUSAL);

  await expect(requestControl(stateDir, { op: "pair" })).rejects.toThrow(REFUSAL);
  await expect(requestControl(stateDir, { op: "mesh-pair", auto: false })).rejects.toThrow(REFUSAL);
  await expect(
    requestControl(stateDir, {
      op: "mesh-join",
      target: "ABCD-EFGH",
      fingerprint: undefined,
      name: undefined,
      relay: undefined,
      yes: true,
    }),
  ).rejects.toThrow(REFUSAL);

  expect(dialed).toEqual([]);
});

const cli = async (...args: readonly string[]) => {
  const child = Bun.spawn([process.execPath, CLI, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
};

/** One line over the loopback push stream, as the app's Settings sends it, and the host's reply. */
async function pushReply(line: object): Promise<unknown> {
  const socket = new WebSocket(`ws://127.0.0.1:${host.port}/v1/push`, [SUBPROTOCOL, `doriface.token.${token}`]);
  socket.binaryType = "arraybuffer";
  const reply = new Promise<unknown>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      const data: unknown = event.data;
      resolve(JSON.parse(data instanceof ArrayBuffer ? new TextDecoder().decode(data) : String(data)));
    });
    socket.addEventListener("close", (event) =>
      reject(new Error(`the push stream closed ${event.code} ${event.reason}`)),
    );
  });
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
  socket.send(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
  try {
    return await reply;
  } finally {
    socket.close();
  }
}

test("a local-only host sends no notifications: its push stream refuses with the reason and it posts to no push service", async () => {
  expect(await pushReply({ t: "hello" })).toEqual({ t: "error", reason: LOCAL_ONLY_PUSH });
  expect(
    await pushReply({
      t: "subscribe",
      subscription: {
        endpoint: "https://fcm.googleapis.com/fcm/send/x",
        p256dh: Buffer.from([4, ...new Uint8Array(64).fill(7)]).toString("base64url"),
        auth: Buffer.from(new Uint8Array(16).fill(9)).toString("base64url"),
      },
      prefs: DEFAULT_PUSH_PREFS,
    }),
  ).toEqual({ t: "error", reason: LOCAL_ONLY_PUSH });
  expect(existsSync(join(stateDir, "push-vapid.json"))).toBe(false);
  expect(dialed).toEqual([]);
});

test("--local-only is a supported option in --help, and a relay or LAN listener beside it is refused", async () => {
  const help = await cli("--help");
  const line = help.stdout.split("\n").find((entry) => entry.trimStart().startsWith("--local-only"));
  expect(line).toBeDefined();
  expect(line).not.toContain("for tests");

  const beside = ["--relay", "--lan-listen", "--auto-update"] as const;
  const values = { "--relay": "wss://relay.example", "--lan-listen": "127.0.0.1:0", "--auto-update": "stable" };
  const refused = await Promise.all(
    beside.map((flag) => cli("--local-only", flag, values[flag], "--state-dir", stateDir)),
  );
  refused.forEach((run, i) => {
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(`--local-only cannot be combined with ${beside[i]}`);
  });
});

test("doriface-host pair against a local-only host exits 1 with the host's reason, not the usage", async () => {
  const refused = await cli("pair", "--state-dir", stateDir);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toStartWith("doriface-host: the running host refused:");
  expect(refused.stderr).toContain(REFUSAL);
  expect(refused.stderr).not.toContain("usage:");
});

test("a host with no relay uplink (--no-relay) looks a typed code up on no relay at all, rather than the release relay", async () => {
  const noRelayDir = mkdtempSync(join(tmpdir(), "dh-no-relay-"));
  const noRelay = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token,
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir: noRelayDir,
    log: () => {},
  });
  try {
    dialed.length = 0;
    const joined = await requestControl(noRelayDir, {
      op: "mesh-join",
      target: "ABCD-EFGH",
      fingerprint: undefined,
      name: undefined,
      relay: undefined,
      yes: true,
    }).then(
      () => "",
      (error: unknown) => String(error),
    );
    expect(joined).toContain("this host keeps no relay uplink");
    expect(dialed).toEqual([]);
  } finally {
    await noRelay.stop();
    rmSync(noRelayDir, { recursive: true, force: true });
  }
});
