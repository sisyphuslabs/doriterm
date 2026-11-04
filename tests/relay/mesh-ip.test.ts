import { afterAll, beforeAll, expect, test } from "bun:test";
import { untilGone } from "./support/mesh/gone.ts";
import { type Mesh, startMesh } from "./support/mesh/mesh.ts";
import { scenario } from "./support/mesh/present.ts";

const NAMES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
/** Inviter of each joiner, spread so no single host carries every join. */
const JOINS = [
  ["a", "b"],
  ["a", "c"],
  ["b", "d"],
  ["c", "e"],
  ["d", "f"],
  ["e", "g"],
  ["f", "h"],
] as const;
/**
 * Design 8.2's bound above five members: the last joiner's machines land after up to 120 s (two more budget windows of
 * its own 12 upgrades per 60 s) plus T_add (20 s). The budget is per host; nothing in it depends on the address.
 */
const CONVERGE_MS = 120_000 + 20_000;
const RATE_LIMITED = 4429;
let mesh: Mesh | undefined;

const running = (): Mesh => {
  if (mesh === undefined) throw new Error("setup failed");
  return mesh;
};

const closeCodes = (hosts: Mesh): readonly number[] => hosts.hosts.flatMap((host) => host.tap?.closeCodes() ?? []);

const provenUpgrades = (hosts: Mesh): number =>
  (hosts.relay?.output() ?? "").split("\n").filter((line) => line.includes('"ev":"proven"')).length;

async function connectedCounts(hosts: Mesh): Promise<readonly number[]> {
  return Promise.all(
    NAMES.map(async (name) => {
      const { machines } = await (await hosts.core(name)).call("machine.list");
      return machines.filter((machine) => machine.state === "connected").length;
    }),
  );
}

scenario("E-IP (any number of hosts behind one address, #119)", ["join", "revoke", "sync", "wire"], () => {
  beforeAll(async () => {
    mesh = await startMesh({ names: NAMES });
    for (const [inviter, joiner] of JOINS) await mesh.join(inviter, joiner);
  }, 900_000);

  afterAll(async () => {
    await mesh?.dispose();
  });

  test("E-IP: eight hosts behind one source IP all join and converge with no 4429 at any host", async () => {
    const hosts = running();
    expect(new Set(hosts.hosts.map((host) => host.tap?.ip)).size).toBe(1);
    const report = async (): Promise<string> =>
      `connected per host ${JSON.stringify(await connectedCounts(hosts))}, closes ${JSON.stringify(closeCodes(hosts))}`;
    await hosts
      .until(
        `every one of ${NAMES.length} hosts lists the other ${NAMES.length - 1} as connected`,
        async () => (await connectedCounts(hosts)).every((count) => count === NAMES.length - 1),
        CONVERGE_MS,
      )
      .catch(async (error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; ${await report()}`);
      });
    expect(closeCodes(hosts).filter((code) => code === RATE_LIMITED)).toEqual([]);
    expect(provenUpgrades(hosts)).toBeGreaterThan(60);
  }, CONVERGE_MS + 60_000);

  test("E-IP: a --compromised revoke converges everywhere, still with no 4429", async () => {
    const hosts = running();
    expect((await hosts.host("a").cli("mesh", "revoke", "--compromised", "h", "--yes")).exit).toBe(0);
    await untilGone(hosts, ["a", "b", "c", "d", "e", "f", "g"], ["h"]);
    expect(closeCodes(hosts).filter((code) => code === RATE_LIMITED)).toEqual([]);
  }, 180_000);
});
