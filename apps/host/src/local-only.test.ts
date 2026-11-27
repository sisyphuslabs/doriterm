import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "./auth.ts";
import { requestControl } from "./control.ts";
import { type Host, startHost } from "./host.ts";
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

test("--local-only is a supported option in --help, and a relay or LAN listener beside it is refused", async () => {
  const help = await cli("--help");
  const line = help.stdout.split("\n").find((entry) => entry.trimStart().startsWith("--local-only"));
  expect(line).toBeDefined();
  expect(line).not.toContain("for tests");

  const beside = ["--relay", "--lan-listen"] as const;
  const values = { "--relay": "wss://relay.example", "--lan-listen": "127.0.0.1:0" };
  const refused = await Promise.all(
    beside.map((flag) => cli("--local-only", flag, values[flag], "--state-dir", stateDir)),
  );
  refused.forEach((run, i) => {
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(`--local-only cannot be combined with ${beside[i]}`);
  });
});
