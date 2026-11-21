import { base64urlEncode, rawStaticKey, secureLink, type SecureLink } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { signCard } from "@doriface/mesh";
import { MeshLines } from "@doriface/mesh/join";
import { OPEN_POLICY } from "@doriface/policy";
import { acceptE2ee } from "../e2ee/accept.ts";
import { LiveSessions } from "../e2ee/sessions.ts";
import { PairingSlots } from "../pairing-slots.ts";
import { DeviceStore } from "../state/devices.ts";
import { cardBody } from "../state/mesh.ts";
import { PairingStore } from "../state/pairing.ts";
import { ownOf, removeSides, side, type Side } from "./join-harness.ts";
import { noiseOf } from "./mesh-history.ts";
import { HostMesh } from "../mesh/host-mesh.ts";

const stops: (() => void)[] = [];
export function clearRosterResumes(): void {
  for (const stop of stops.splice(0)) stop();
  removeSides();
}
const log = () => {};

export function fixture(options: { readonly changed?: () => void; readonly log?: (line: string) => void } = {}) {
  const a = side("alpha");
  const c = side("browser");
  a.mesh.found(a.m.identity, ownOf(a));
  const devices = new DeviceStore(a.dir);
  const pairing = new PairingStore(a.dir);
  const slots = new PairingSlots(pairing, a.m.identity.noise.publicKey, undefined, log);
  const sessions = new LiveSessions(devices, log, a.mesh);
  const host = new HostMesh({
    ...options,
    stateDir: a.dir,
    identity: a.m.identity,
    mesh: a.mesh,
    slots,
    sessions,
    policy: OPEN_POLICY,
    hc: { hc: "unused" },
    relay: { url: undefined },
    floor: () => undefined,
    formatReady: () => true,
    log: options.log ?? log,
  });
  stops.push(() => {
    host.pending.expireAll();
    host.resumes.clear();
    slots.stop();
  });
  const deps = {
    identity: a.m.identity,
    mesh: a.mesh,
    devices,
    pairing,
    policy: OPEN_POLICY,
    live: sessions,
    lanUrls: [],
    log,
    resumeKey: (key: string) => host.resumeKey(key),
    removedRosterHeld: (key: string) => host.removedRosterHeld(key),
  };
  return { a, c, devices, pairing, host, deps };
}

export async function open(f: ReturnType<typeof fixture>, kind: "pair" | "roster", client: Side = f.c) {
  const [hostEnd, clientEnd] = memoryLinkPair(true);
  const offer = f.pairing.read();
  if (kind === "pair" && offer === undefined) throw new Error("no pairing offer");
  let refusal: unknown;
  const [host, joined] = await Promise.all([
    acceptE2ee(hostEnd, f.deps, { kind: "relay" }),
    secureLink(clientEnd, {
      role: "initiator",
      hostId: f.a.m.identity.hostId,
      staticKey: rawStaticKey(client.m.identity.noise),
      remoteStatic: f.a.m.identity.noise.publicKey,
      stream: kind === "pair" ? "mesh" : "roster",
      ...(kind === "pair" && offer !== undefined
        ? { pairing: { mode: "link" as const, linkSecret: offer.linkSecret, name: client.m.name } }
        : {}),
    }).catch((error: unknown) => {
      refusal = error;
      return undefined;
    }),
  ]);
  stops.push(() => {
    host?.close();
    joined?.close();
  });
  return { host, joined, hostEnd, refusal };
}

export const required = (link: SecureLink | undefined): SecureLink => {
  if (link === undefined) throw new Error("the session was refused");
  return link;
};

export async function droppedJoin() {
  const f = fixture();
  await f.host.pair(false);
  const dial = await open(f, "pair");
  const secure = required(dial.joined);
  const client = new MeshLines(secure, ["offer", "reveal", "refused"]);
  f.host.serve(required(dial.host));
  const offer = await client.next();
  if (offer.t !== "offer") throw new Error("no offer");
  const Nj = new Uint8Array(32).fill(17);
  const card = signCard(
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
  );
  dial.hostEnd.tap = () => [];
  client.send({ t: "card", ...card, sas: base64urlEncode(Nj) });
  const pending = await f.host.pending.next();
  secure.close();
  await client.ended;
  return { ...f, offer, pending, Nj, h: secure.handshakeHash };
}

export async function resume(f: ReturnType<typeof fixture>, nonce: string) {
  const dial = await open(f, "roster");
  const client = new MeshLines(required(dial.joined), ["offer", "reveal", "records", "done", "refused"]);
  f.host.roster(required(dial.host));
  client.send({ t: "resume", nonce });
  const first = await client.next();
  return { client, first: first.t === "offer" ? await client.next() : first };
}
