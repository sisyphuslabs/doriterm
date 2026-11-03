import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lookupPairSlot, PairLookupError } from "@doriface/relay-client";
import { HOST_NAMES, type Mesh, type Receipt, startMesh } from "./support/mesh/mesh.ts";
import { testIp } from "./support/probe.ts";
import { inOrder } from "./support/sequential.ts";

const PAIR_CODE = /^code\s+(\S{4} \S{4})$/m;
let mesh: Mesh | undefined;
let receipt: Receipt | undefined;

const started = (): Mesh => {
  if (mesh === undefined) throw new Error("setup failed");
  return mesh;
};

beforeAll(async () => {
  mesh = await startMesh();
}, 180_000);

afterAll(async () => {
  if (receipt === undefined) await mesh?.dispose();
});

/** One pairing-slot lookup through `relayUrl`, on a fresh connection so a tap sees (and stamps) every request. */
const lookup = (relayUrl: string, code: string, ip?: string): Promise<string | number | undefined> =>
  lookupPairSlot({
    relayUrl,
    code,
    fetch: (url) =>
      fetch(url, { headers: { connection: "close", ...(ip === undefined ? {} : { "cf-connecting-ip": ip }) } }),
  }).then(
    (record) => record?.hostId,
    (error: unknown) => (error instanceof PairLookupError ? error.status : undefined),
  );

describe("the four-host relay harness, before any mesh command exists", () => {
  test("a, b, c and d are separate processes with their own state dirs, hc sessions and host ids", () => {
    const { hosts } = started();
    expect(hosts.map((host) => host.name)).toEqual([...HOST_NAMES]);
    for (const key of ["hostId", "stateDir", "sessionDir"] as const) {
      expect(new Set(hosts.map((host) => host[key])).size).toBe(HOST_NAMES.length);
    }
    expect(new Set(hosts.map((host) => host.pid())).size).toBe(HOST_NAMES.length);
    expect(hosts.every((host) => host.pid() !== process.pid)).toBe(true);
  });

  test("each host's own hc core answers as that host's session, so no core is shared", async () => {
    const running = started();
    const answers = await Promise.all(
      running.hosts.map(async (host) => {
        const result = await (await running.core(host.name)).call("machine.exec", { line: "echo $HC_SESSION" });
        return Buffer.from(result.stdout, "base64").toString("utf8").trim();
      }),
    );
    expect(answers).toEqual(running.hosts.map((host) => host.session.name));
  });

  test("the relay counts all four taps as one source: the per-source lookup quota (3) is spent across them", async () => {
    const running = started();
    const a = running.host("a");
    const printed = await a.cli("pair", "--no-qr", "--relay", a.tap?.url ?? "");
    const code = PAIR_CODE.exec(printed.stdout)?.[1];
    if (code === undefined) throw new Error(`pair printed no registered code: ${printed.stdout}${printed.stderr}`);
    const answers = await inOrder(running.hosts, (host) => lookup(host.tap?.url ?? "", code));
    expect(answers).toEqual([a.hostId, a.hostId, a.hostId, 429]);
    expect(await lookup(running.relay?.url ?? "", code, testIp())).toBe(a.hostId);
  }, 60_000);

  test("cutting one host's tap partitions that host alone, and healing brings its uplink back", async () => {
    const running = started();
    const a = running.host("a");
    const tapA = a.tap;
    if (tapA === undefined) throw new Error("a has no tap");
    const others = running.hosts.filter((host) => host.name !== "a");
    const openBefore = others.map((host) => host.tap?.open());
    const closed = a.nextLog(/relay: uplink closed/, "a's uplink closing");
    tapA.cut();
    await closed;
    await running.until("a's tap has no connection left", () => tapA.open() === 0);
    expect(others.map((host) => host.tap?.open())).toEqual(openBefore);
    const back = a.nextLog(/relay: connected/, "a's uplink coming back", 60_000);
    tapA.heal();
    await back;
    expect(tapA.open()).toBeGreaterThan(0);
  }, 120_000);

  test("teardown leaves no process of any kind behind, and no tap listening", async () => {
    receipt = await started().dispose();
    const kinds = Object.groupBy(receipt.owned, (own) => own.kind);
    const counts = Object.entries(kinds).map(([kind, list]) => `${kind}=${list?.length ?? 0}`);
    console.log(
      `teardown receipt: ${counts.join(" ")} alive=${receipt.alive.length} listening=${receipt.listening.length}`,
    );
    for (const kind of ["host", "hc-core", "hc-connect", "relay"] as const)
      expect(kinds[kind]?.length ?? 0).toBeGreaterThan(0);
    expect(receipt.alive).toEqual([]);
    expect(receipt.listening).toEqual([]);
  }, 60_000);
});
