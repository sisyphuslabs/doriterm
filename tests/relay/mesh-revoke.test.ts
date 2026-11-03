import { afterAll, beforeAll, expect, test } from "bun:test";
import { base64urlEncode, generateX25519 } from "@doriface/crypto";
import { dialAs, type Dialed, refusalCodes } from "./support/mesh/dial.ts";
import { deviceKeys, seedDevices } from "./support/mesh/devices.ts";
import { untilFullMesh } from "./support/mesh/echo.ts";
import { watchForbidden } from "./support/mesh/forbidden-watch.ts";
import { untilGone } from "./support/mesh/gone.ts";
import { holdLine } from "./support/mesh/held-line.ts";
import { identityOf, mintIdentity } from "./support/mesh/identity.ts";
import { type Mesh, startMesh } from "./support/mesh/mesh.ts";
import { scenario } from "./support/mesh/present.ts";
import { machineIds, meshFileOf } from "./support/mesh/status.ts";
import { within } from "./support/watch.ts";

const NAMES = ["a", "b", "c", "d", "e"] as const;
const REFUSED = 4401;
const CLOSE_MS = 60_000;
let mesh: Mesh | undefined;

const running = (): Mesh => {
  if (mesh === undefined) throw new Error("setup failed");
  return mesh;
};

async function refusedBy(hosts: Mesh, who: string, targets: readonly string[]): Promise<void> {
  const keys = identityOf(hosts.host(who));
  const dialed = await Promise.all(targets.map((target) => dialAs(hosts, keys, hosts.host(target))));
  expect(refusalCodes(dialed)).toEqual(targets.map(() => REFUSED));
}

scenario(
  "E-OUT and E-REVOKE (outsiders refused, revoke and --compromised everywhere)",
  ["join", "status", "revoke", "bridge", "reconciler", "wire", "sync"],
  () => {
    beforeAll(async () => {
      mesh = await startMesh({ names: NAMES });
      await mesh.join("a", "b");
      await mesh.join("a", "c");
      await mesh.join("c", "d");
      await mesh.join("a", "e");
      await untilFullMesh(mesh, NAMES);
    }, 300_000);

    afterAll(async () => {
      await mesh?.dispose();
    });

    test("E-OUT: an outsider's mesh-stream and hc dials get 4401 from every member, and leave no record or machine", async () => {
      const hosts = running();
      const outsider = mintIdentity();
      const records = () => NAMES.map((name) => meshFileOf(hosts.host(name)).records.length);
      const machines = () => Promise.all(NAMES.map((name) => machineIds(hosts, name)));
      const [recordsBefore, machinesBefore] = [records(), await machines()];
      const watch = watchForbidden(hosts, NAMES, { hostIds: [outsider.hostId], coreIds: [] });
      const byStream = await Promise.all(
        (["mesh", "hc"] as const).map((stream) =>
          Promise.all(hosts.hosts.map((host) => dialAs(hosts, outsider, host, stream))),
        ),
      );
      expect(byStream.map(refusalCodes)).toEqual([NAMES.map(() => REFUSED), NAMES.map(() => REFUSED)]);
      expect(records()).toEqual(recordsBefore);
      expect(await machines()).toEqual(machinesBefore);
      expect(await watch.stop()).toEqual([]);
    }, 60_000);

    test("E-REVOKE: a revoke on a reaches every member, the revoked host is refused by all, and it drops its machines", async () => {
      const hosts = running();
      expect((await hosts.host("a").cli("mesh", "revoke", "e", "--yes")).exit).toBe(0);
      await untilGone(hosts, ["a", "b", "c", "d"], ["e"]);
      await refusedBy(hosts, "e", ["a", "b", "c", "d"]);
      await hosts.until(
        "e removes its own mesh machines (6.4)",
        async () => (await machineIds(hosts, "e")).length === 0,
      );
    }, 180_000);

    test("E-REVOKE --compromised c: c and d go everywhere, with their sessions (4401), lines and device entries", async () => {
      const hosts = running();
      const watchers = ["a", "b"];
      const revoked = ["c", "d"];
      const unrelated = generateX25519().publicKey;
      for (const name of watchers) {
        seedDevices(hosts.host(name), [
          ...revoked.map((who) => ({ key: identityOf(hosts.host(who)).noise.publicKey, name: `old-${who}` })),
          { key: unrelated, name: "phone" },
        ]);
      }
      const sessions: readonly Dialed[] = await Promise.all(
        revoked.flatMap((who) => watchers.map((name) => dialAs(hosts, identityOf(hosts.host(who)), hosts.host(name)))),
      );
      expect(sessions.map((session) => session.kind)).toEqual(sessions.map(() => "open"));
      const lines = await Promise.all(
        watchers.flatMap((name) => revoked.map((who) => holdLine(hosts.host(name), hosts.host(who)))),
      );
      expect(lines.map((line) => line.isOpen())).toEqual(lines.map(() => true));

      expect((await hosts.host("a").cli("mesh", "revoke", "--compromised", "c", "--yes")).exit).toBe(0);
      await untilGone(hosts, watchers, revoked);
      const closes = sessions.map((session) => (session.kind === "open" ? session.closed : Promise.resolve(-1)));
      expect(await within(Promise.all(closes), "the revoked members' sessions closing", CLOSE_MS)).toEqual(
        closes.map(() => REFUSED),
      );
      await within(Promise.all(lines.map((line) => line.closed)), "the watchers' outbound lines closing", CLOSE_MS);
      const kept = [base64urlEncode(unrelated)];
      await hosts.until("device entries of c and d removed on a and b (6.7)", () =>
        watchers.every((name) => JSON.stringify(deviceKeys(hosts.host(name))) === JSON.stringify(kept)),
      );
      await Promise.all(revoked.map((who) => refusedBy(hosts, who, watchers)));
      await hosts.until("c and d remove their own mesh machines (6.4)", async () =>
        (await Promise.all(revoked.map((name) => machineIds(hosts, name)))).every((ids) => ids.length === 0),
      );
    }, 240_000);
  },
);
