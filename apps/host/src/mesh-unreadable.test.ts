import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "./auth.ts";
import { requestControl } from "./control.ts";
import { type Host, startHost } from "./host.ts";
import { loadHostIdentity } from "./state/host-keys.ts";
import { MeshStore } from "./state/mesh.ts";
import { MESH_FILE } from "./state/mesh-file.ts";
import { createHcSession, type HcSession } from "./testing/hc-session.ts";

const CLI = join(import.meta.dir, "cli.ts");
const token = generateToken();
let session: HcSession;
let stateDir: string;
let host: Host;
let logs: string[];
/** Each log line, as it is written: a test awaits the one it names instead of sleeping. */
let heard: ((line: string) => void) | undefined;

/** Every request or socket this process opens to anything but this computer while the spies are in. */
const dialed: string[] = [];
const realFetch = globalThis.fetch;
const RealWebSocket = globalThis.WebSocket;
const outside = (url: string | URL): boolean => !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
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

beforeEach(async () => {
  dialed.length = 0;
  logs = [];
  stateDir = mkdtempSync(join(tmpdir(), "dh-mesh-unreadable-"));
  writeFileSync(join(stateDir, MESH_FILE), "{", { mode: 0o600 });
  session = createHcSession("doriface-mesh-unreadable-test");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token,
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir,
    log: (line) => {
      logs.push(line);
      heard?.(line);
    },
  });
});
afterEach(async () => {
  await host.stop();
  await session.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

const meshFile = () => join(stateDir, MESH_FILE);
const unreadableLines = () => logs.filter((line) => line.startsWith("mesh: mesh state unreadable: "));

test("a host over an unreadable mesh.json still starts, says why once, keeps the file as it is and admits no member", async () => {
  expect((await realFetch(`http://127.0.0.1:${host.port}/healthz`)).status).toBe(200);
  expect(unreadableLines()).toHaveLength(1);
  expect(unreadableLines()[0]).toContain(meshFile());
  expect(readFileSync(meshFile(), "utf8")).toBe("{");
  expect(new MeshStore(stateDir, { log: () => {} }).authorizeIndex()).toBeUndefined();
});

test("a mesh offer or join is refused up front, naming the file, and nothing is dialed", async () => {
  const offer = await requestControl(stateDir, { op: "mesh-pair", auto: false }).then(
    () => "",
    (error: unknown) => String(error),
  );
  const joined = await requestControl(stateDir, {
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
  for (const refusal of [offer, joined]) expect(refusal).toContain(`mesh state unreadable: ${meshFile()}`);
  expect(dialed).toEqual([]);
});

test("mesh status names the unreadable file instead of 'in no mesh', in the reply and on the command line", async () => {
  const reply = await requestControl(stateDir, { op: "mesh-status" });
  expect(Object.keys(Object(reply))).toEqual(["unreadable"]);
  expect(String(Reflect.get(Object(reply), "unreadable"))).toStartWith(`mesh state unreadable: ${meshFile()}`);
  const status = Bun.spawn([process.execPath, CLI, "mesh", "status", "--state-dir", stateDir], { stdout: "pipe" });
  const [out, code] = await Promise.all([new Response(status.stdout).text(), status.exited]);
  expect(code).toBe(1);
  expect(out).toStartWith(`mesh state unreadable: ${meshFile()}`);
});

test("a mesh.json repaired while the host runs is picked up without a restart: sync starts on it", async () => {
  const started = new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("sync did not start on the repaired mesh.json")), 10_000);
    heard = (line) => {
      if (!line.startsWith("mesh: sync started for mesh ")) return;
      clearTimeout(deadline);
      resolve(line);
    };
  });
  rmSync(meshFile());
  const repaired = new MeshStore(stateDir, { log: () => {} });
  expect(repaired.found(loadHostIdentity(stateDir), { name: "alpha", hcId: "" })).toBe(true);
  expect(await started).toBe(`mesh: sync started for mesh ${repaired.read()?.meshId ?? "?"}`);
  heard = undefined;
});
