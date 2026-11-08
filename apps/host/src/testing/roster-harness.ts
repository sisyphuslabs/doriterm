import { memoryLinkPair } from "@doriface/crypto/testing";
import { signCard } from "@doriface/mesh";
import { JOINER_EXPECTS, MeshLines, ROSTER_EXPECTS } from "@doriface/mesh/join";
import { OPEN_POLICY } from "@doriface/policy";
import { DeviceStore } from "../state/devices.ts";
import { cardBody } from "../state/mesh.ts";
import { failure, ownOf, side, type Side } from "./join-harness.ts";
import { noiseOf } from "./mesh-history.ts";
import { serveRoster, type RosterDeps } from "../mesh/roster.ts";

export function setup(found = true) {
  const a = side("alpha");
  const c = side("browser");
  if (found) a.mesh.found(a.m.identity, ownOf(a));
  const devices = new DeviceStore(a.dir);
  devices.add(c.m.identity.noise.publicKey, "browser");
  const deps: RosterDeps = {
    identity: a.m.identity,
    mesh: a.mesh,
    devices,
    stateDir: a.dir,
    policy: OPEN_POLICY,
    formatReady: () => true,
    floor: () => undefined,
    log() {},
  };
  return { a, c, devices, deps };
}

export async function exchange(deps: RosterDeps, c: Side, mutate = (card: ReturnType<typeof cardBody>) => card) {
  const [hostEnd, clientEnd] = memoryLinkPair(true);
  const client = new MeshLines(clientEnd, JOINER_EXPECTS);
  const serving = failure(serveRoster(new MeshLines(hostEnd, ROSTER_EXPECTS), c.m.identity.noise.publicKey, deps));
  const offer = await client.next();
  if (offer.t !== "offer") return { serving, client, hostEnd, first: offer };
  const body = mutate(
    cardBody(
      c.m.identity,
      { name: "browser", hcId: "", devicePub: noiseOf(c.m) },
      offer.mesh,
      offer.inviter,
      offer.nonce,
      "client",
    ),
  );
  client.expect("records", "done", "refused");
  client.send({ t: "card", ...signCard(body, c.m.identity.sign.secretKey) });
  return { serving, client, hostEnd, first: await client.next() };
}
