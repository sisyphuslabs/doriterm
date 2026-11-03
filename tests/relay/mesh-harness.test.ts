import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HOST_NAMES, type Mesh, type Receipt, startMesh } from "./support/mesh/mesh.ts";

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

describe("the four-host relay harness, before any mesh command exists", () => {
  test("a, b, c and d are separate processes with their own state dirs, hc sessions and host ids", () => {
    const { hosts } = started();
    expect(hosts.map((host) => host.name)).toEqual([...HOST_NAMES]);
    for (const key of ["pid", "hostId", "stateDir"] as const) {
      expect(new Set(hosts.map((host) => host[key])).size).toBe(HOST_NAMES.length);
    }
    expect(new Set(hosts.map((host) => host.session.name)).size).toBe(HOST_NAMES.length);
    expect(hosts.every((host) => host.pid !== process.pid)).toBe(true);
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

  test("every host dials the relay through a tap of its own, all four from one source IP", () => {
    const { hosts, relay } = started();
    const taps = hosts.map((host) => host.tap);
    expect(taps.every((tap) => tap !== undefined && tap.bytes() > 0 && tap.open() > 0)).toBe(true);
    expect(new Set(taps.map((tap) => tap?.url)).size).toBe(HOST_NAMES.length);
    expect(new Set(taps.map((tap) => tap?.ip))).toEqual(new Set([relay?.ip]));
  });

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
    expect(tapA.open()).toBe(0);
    expect(others.map((host) => host.tap?.open())).toEqual(openBefore);
    const back = a.nextLog(/relay: connected/, "a's uplink coming back", 60_000);
    tapA.heal();
    await back;
    expect(tapA.open()).toBeGreaterThan(0);
  }, 120_000);

  test("teardown leaves no host process behind", async () => {
    receipt = await started().dispose();
    console.log(`teardown receipt: pids=${receipt.pids.join(",")} alive=${receipt.alive.length}`);
    expect(receipt.alive).toEqual([]);
  }, 60_000);
});
