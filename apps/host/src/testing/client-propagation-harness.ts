import { base64urlEncode, rawStaticKey, secureLink } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { signCard } from "@doriface/mesh";
import { MeshLines } from "@doriface/mesh/join";
import { authorizationOf, sessionPeer } from "../e2ee/authorize.ts";
import { LiveSessions } from "../e2ee/sessions.ts";
import { HostSync } from "../mesh/host-sync.ts";
import { FakeClock, seededRandom, settle } from "../mesh/testing/fake-clock.ts";
import { DeviceStore } from "../state/devices.ts";
import { cardBody } from "../state/mesh.ts";
import { side } from "./join-harness.ts";
import { cardFor, noiseOf, signPubOf } from "./mesh-history.ts";
import { clearRosterResumes, fixture, open, required } from "./roster-resume-harness.ts";

const syncs: HostSync[] = [];
export async function clearPropagation(): Promise<void> {
  await Promise.all(syncs.splice(0).map((sync) => sync.stop()));
  clearRosterResumes();
}

export async function roster(f: ReturnType<typeof fixture>, client = f.c, action: "card" | "leave" = "card") {
  const dial = await open(f, "roster", client);
  const lines = new MeshLines(required(dial.joined), ["offer", "records", "done", "refused"]);
  f.host.roster(required(dial.host));
  const offer = await lines.next();
  if (offer.t !== "offer") throw new Error("no roster offer");
  const card = signCard(
    cardBody(
      client.m.identity,
      {
        name: client.m.name,
        hcId: "",
        devicePub: noiseOf(client.m),
      },
      offer.mesh,
      offer.inviter,
      offer.nonce,
      "client",
    ),
    client.m.identity.sign.secretKey,
  );
  lines.send(action === "card" ? { t: "card", ...card } : { t: "leave", card });
  await welcome(lines);
}

export async function welcome(lines: MeshLines): Promise<void> {
  const first = await lines.next();
  if (first.t !== "records") throw new Error(`expected records, got ${JSON.stringify(first)}`);
  if ((await lines.next()).t !== "done") throw new Error("no welcome completion");
}

/** Two real HostSync runtimes with persisted stores and an authenticated standing gossip connection. */
export async function twoHosts(seedClients = false) {
  let syncA: HostSync | undefined;
  const f = fixture({ changed: () => syncA?.changed() });
  const b = side("beta");
  const other = side("other-browser");
  const mesh = f.a.mesh.read()?.meshId ?? "";
  f.a.mesh.sign(f.a.m.identity, (n, prev) => ({
    v: 2,
    mesh,
    type: "admit",
    by: signPubOf(f.a.m),
    n,
    prev,
    subject: { card: cardFor(b.m, mesh, f.a.m) },
  }));
  if (seedClients) {
    const clients = [f.c, other];
    for (const client of clients) {
      f.devices.add(client.m.identity.noise.publicKey, client.m.name);
    }
    await Promise.all(clients.map((client) => roster(f, client)));
  }
  b.mesh.adopt(f.a.mesh.read()?.records ?? [], b.m.identity);
  const clock = new FakeClock();
  const syncFor = (owner: typeof f.a) =>
    new HostSync({
      identity: owner.m.identity,
      mesh: owner.mesh,
      stateDir: owner.dir,
      relay: { url: undefined },
      hc: { hc: "hc-not-installed" },
      program: "/opt/doriface-host",
      openFrom: () => false,
      closeRevoked: () => (owner === f.a ? f.deps.live : sessionsB).closeRevoked(),
      log: (line) => {
        owner.logs.push(line);
      },
      clock,
      random: seededRandom(71),
    });
  const sessionsB = new LiveSessions(new DeviceStore(b.dir), () => {}, b.mesh);
  syncA = syncFor(f.a);
  const syncB = syncFor(b);
  syncs.push(syncA, syncB);
  const [aEnd, bEnd] = memoryLinkPair(true);
  const [aSecure, bSecure] = await Promise.all([
    secureLink(aEnd, {
      role: "initiator",
      hostId: b.m.identity.hostId,
      stream: "mesh",
      staticKey: rawStaticKey(f.a.m.identity.noise),
      remoteStatic: b.m.identity.noise.publicKey,
    }),
    secureLink(bEnd, {
      role: "responder",
      hostId: b.m.identity.hostId,
      staticKey: rawStaticKey(b.m.identity.noise),
      authorize: (hello) =>
        authorizationOf(sessionPeer(hello.stream, hello.remoteStatic, b.mesh.authorizeIndex(), new DeviceStore(b.dir))),
    }),
  ]);
  syncA.adopt(aSecure);
  syncB.adopt(bSecure);
  await clock.advance(1);
  await settle();
  return { ...f, b, other, syncA, syncB, clock };
}

export async function beginClient(f: ReturnType<typeof fixture>) {
  await f.host.pair(false);
  const dial = await open(f, "pair");
  const lines = new MeshLines(required(dial.joined), ["offer", "reveal", "records", "done", "refused"]);
  f.host.serve(required(dial.host));
  const offer = await lines.next();
  if (offer.t !== "offer") throw new Error("no invite offer");
  lines.send({
    t: "card",
    ...signCard(
      cardBody(
        f.c.m.identity,
        {
          name: "browser",
          hcId: "",
          devicePub: noiseOf(f.c.m),
        },
        offer.mesh,
        offer.inviter,
        offer.nonce,
        "client",
      ),
      f.c.m.identity.sign.secretKey,
    ),
    sas: base64urlEncode(new Uint8Array(32).fill(17)),
  });
  if ((await lines.next()).t !== "reveal") throw new Error("no reveal");
  const pending = await f.host.pending.next();
  return { dial, lines, pending };
}
