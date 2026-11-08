import { signCard } from "@doriface/mesh";
import { afterEach, expect, test } from "bun:test";
import { cardBody } from "../state/mesh.ts";
import { benchRecords, commandBench, removeBenches } from "../testing/mesh-commands-bench.ts";
import { machine, noiseOf, signPubOf } from "../testing/mesh-history.ts";

afterEach(removeBenches);

function clients() {
  const a = machine("alpha");
  const b = machine("beta");
  const c = machine("browser");
  const d = machine("phone");
  const it = commandBench(a);
  it.mesh.admit(a, b);
  for (const client of [c, d]) {
    const card = signCard(
      cardBody(
        client.identity,
        {
          name: client.name,
          hcId: "",
          devicePub: noiseOf(client),
        },
        it.mesh.meshId,
        signPubOf(b),
        undefined,
        "client",
      ),
      client.identity.sign.secretKey,
    );
    it.mesh.record(b, "admit", { card });
  }
  it.ready();
  return { a, b, c, d, it };
}

test("a machine revoke previews all dependent clients before requiring confirmation", async () => {
  const { b, c, d, it } = clients();
  const before = benchRecords(it);
  const reply = await it.commands.revoke({ member: b.name, compromised: false, yes: false, preview: true });
  expect(reply?.clients.map((client) => client.hostId).toSorted()).toEqual(
    [c.identity.hostId, d.identity.hostId].toSorted(),
  );
  expect(reply?.needsYes).toBe(true);
  expect(benchRecords(it)).toEqual(before);
});

test("leave previews the clients bound to the departing machine without signing", () => {
  const { a, it } = clients();
  const own = machine("own-browser");
  const card = signCard(
    cardBody(
      own.identity,
      {
        name: own.name,
        hcId: "",
        devicePub: noiseOf(own),
      },
      it.mesh.meshId,
      signPubOf(a),
      undefined,
      "client",
    ),
    own.identity.sign.secretKey,
  );
  it.mesh.record(a, "admit", { card });
  const before = benchRecords(it);
  expect(it.commands.leavePreview().clients).toEqual([{ hostId: own.identity.hostId, name: own.name }]);
  expect(benchRecords(it)).toEqual(before);
});
