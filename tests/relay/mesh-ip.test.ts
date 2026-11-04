import { afterAll, beforeAll, expect, test } from "bun:test";
import { untilGone } from "./support/mesh/gone.ts";
import { type Mesh, startMesh } from "./support/mesh/mesh.ts";
import { scenario } from "./support/mesh/present.ts";
import { inOrder } from "./support/sequential.ts";

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
/** Design 8.2: after a relay restart every line is back within 120 s in general (60 s when uplinks return in 5 s). */
const RESTART_MS = 120_000;
const RATE_LIMITED = 4429;
const REMAINING = ["a", "b", "c", "d", "e", "f", "g"] as const;
let mesh: Mesh | undefined;

const running = (): Mesh => {
  if (mesh === undefined) throw new Error("setup failed");
  return mesh;
};

const closeCodes = (hosts: Mesh): readonly number[] => hosts.hosts.flatMap((host) => host.tap?.closeCodes() ?? []);

/**
 * A host's dial budget is halved only when a dial of its own is refused with 4429 (dial-policy.ts `report`), so no
 * 4429 on any socket the relay closed toward a host, and no host logging a rate limit, means every host kept its full
 * 12 per 60 s budget.
 */
function expectFullBudgets(hosts: Mesh): void {
  expect(closeCodes(hosts).filter((code) => code === RATE_LIMITED)).toEqual([]);
  expect(hosts.hosts.flatMap((host) => host.logs.filter((line) => line.includes("(4429)")))).toEqual([]);
}

const provenUpgrades = (hosts: Mesh): number =>
  (hosts.relay?.output() ?? "").split("\n").filter((line) => line.includes('"ev":"proven"')).length;

async function connectedCounts(hosts: Mesh, names: readonly string[] = NAMES): Promise<readonly number[]> {
  return Promise.all(
    names.map(async (name) => {
      const { machines } = await (await hosts.core(name)).call("machine.list");
      return machines.filter((machine) => machine.state === "connected").length;
    }),
  );
}

scenario("E-IP (any number of hosts behind one address, #119)", ["join", "revoke", "sync", "wire"], () => {
  beforeAll(async () => {
    const started = await startMesh({ names: NAMES });
    mesh = started;
    await inOrder(JOINS, ([inviter, joiner]) => started.join(inviter, joiner));
  }, 900_000);

  afterAll(async () => {
    await mesh?.dispose();
  });

  test(
    "E-IP: eight hosts behind one source IP all join and converge with no 4429 at any host",
    async () => {
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
      expectFullBudgets(hosts);
      expect(provenUpgrades(hosts)).toBeGreaterThan(60);
    },
    CONVERGE_MS + 60_000,
  );

  test("E-IP: a --compromised revoke converges everywhere, still with no 4429", async () => {
    const hosts = running();
    expect((await hosts.host("a").cli("mesh", "revoke", "--compromised", "h", "--yes")).exit).toBe(0);
    await untilGone(hosts, REMAINING, ["h"]);
    expectFullBudgets(hosts);
  }, 180_000);

  test(
    "E-IP: after a relay restart every remaining line is back within the bound, still with no 4429",
    async () => {
      const hosts = running();
      const relay = hosts.relay;
      if (relay === undefined) throw new Error("E-IP needs the local relay");
      const provenBefore = provenUpgrades(hosts);
      await relay.restart();
      await hosts.until(
        `every one of ${REMAINING.length} remaining hosts lists the other ${REMAINING.length - 1} as connected again`,
        async () => (await connectedCounts(hosts, REMAINING)).every((count) => count === REMAINING.length - 1),
        RESTART_MS,
      );
      expectFullBudgets(hosts);
      expect(provenUpgrades(hosts)).toBeGreaterThan(provenBefore);
    },
    RESTART_MS + 120_000,
  );
});
