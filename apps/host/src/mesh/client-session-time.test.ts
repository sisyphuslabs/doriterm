import { rawStaticKey, secureLink, type Stream } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { signCard } from "@doriface/mesh";
import { MeshLines } from "@doriface/mesh/join";
import { parseMeshStatus } from "@doriface/protocol";
import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { acceptE2ee } from "../e2ee/accept.ts";
import { writePrivateJson } from "../state/files.ts";
import { cardBody, MeshStore } from "../state/mesh.ts";
import { meshFileJson } from "../state/mesh-file.ts";
import { side, type Side } from "../testing/join-harness.ts";
import { noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { clearRosterResumes, fixture, open, required } from "../testing/roster-resume-harness.ts";
import { IDLE_MESH_HOOKS } from "./host-hooks.ts";
import { storedMeshStatus } from "./status-store.ts";

const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
  clearRosterResumes();
});
const AT = 1_790_000_000_000;

function clients() {
  const f = fixture();
  const other = side("other-browser");
  const mesh = f.a.mesh.read()?.meshId ?? "";
  for (const client of [f.c, other]) {
    const card = signCard(
      cardBody(
        client.m.identity,
        {
          name: client.m.name,
          hcId: "",
          devicePub: noiseOf(client.m),
        },
        mesh,
        signPubOf(f.a.m),
        undefined,
        "client",
      ),
      client.m.identity.sign.secretKey,
    );
    f.a.mesh.sign(f.a.m.identity, (n, prev) => ({
      v: 2,
      mesh,
      type: "admit",
      by: signPubOf(f.a.m),
      n,
      prev,
      subject: { card },
    }));
  }
  return { ...f, other, mesh };
}

async function accept(f: ReturnType<typeof clients>, stream: Stream | undefined, who: Side = f.c) {
  const [hostEnd, clientEnd] = memoryLinkPair(true);
  const [host, client] = await Promise.all([
    acceptE2ee(hostEnd, f.deps, { kind: "relay" }),
    secureLink(clientEnd, {
      role: "initiator",
      hostId: f.a.m.identity.hostId,
      staticKey: rawStaticKey(who.m.identity.noise),
      remoteStatic: f.a.m.identity.noise.publicKey,
      ...(stream === undefined ? {} : { stream }),
    }).catch(() => undefined),
  ]);
  closes.push(() => {
    host?.close();
    client?.close();
  });
  return host;
}

const status = (f: ReturnType<typeof clients>, store = f.a.mesh) =>
  storedMeshStatus(store, f.a.m.identity, IDLE_MESH_HOOKS);
const lastSeen = (f: ReturnType<typeof clients>, store = f.a.mesh) =>
  status(f, store)?.members.find((member) => member.hostId === f.c.m.identity.hostId)?.lastSessionAt;

test.each([undefined, "roster", "push"] as const)(
  "an accepted %s client session is local status that survives restart",
  async (stream) => {
    const f = clients();
    const before = f.a.mesh.read()?.records;
    expect(status(f)?.members.every((member) => member.lastSessionAt === undefined)).toBe(true);
    const clock = spyOn(Date, "now").mockReturnValue(AT);
    try {
      expect(await accept(f, stream)).toBeDefined();
    } finally {
      clock.mockRestore();
    }
    expect(lastSeen(f)).toBe(AT);
    const current = status(f);
    expect(
      current?.members.filter((member) => member.lastSessionAt !== undefined).map((member) => member.hostId),
    ).toEqual([f.c.m.identity.hostId]);
    expect(
      parseMeshStatus(current)?.members.find((member) => member.hostId === f.c.m.identity.hostId)?.lastSessionAt,
    ).toBe(AT);
    const restarted = new MeshStore(f.a.dir, { log: () => {} });
    expect(lastSeen(f, restarted)).toBe(AT);
    const later = spyOn(Date, "now").mockReturnValue(AT + 2000);
    try {
      expect(await accept(f, stream)).toBeDefined();
    } finally {
      later.mockRestore();
    }
    expect(lastSeen(f, restarted)).toBe(AT + 2000);
    expect(restarted.read()?.records).toEqual(before ?? []);
  },
);

test("client session time survives a record write and a stale-index rebuild without being gossiped", async () => {
  const f = clients();
  const clock = spyOn(Date, "now").mockReturnValue(AT);
  try {
    await accept(f, undefined);
  } finally {
    clock.mockRestore();
  }
  f.a.mesh.sign(f.a.m.identity, (n, prev) => ({
    v: 2,
    mesh: f.mesh,
    type: "ack",
    by: signPubOf(f.a.m),
    n,
    prev,
  }));
  expect(lastSeen(f)).toBe(AT);
  const file = f.a.mesh.read();
  if (file?.index === undefined) throw new Error("no persisted index");
  writePrivateJson(join(f.a.dir, "mesh.json"), {
    ...meshFileJson(file),
    index: { ...file.index, generation: file.generation - 1 },
  });
  const restarted = new MeshStore(f.a.dir, { log: () => {} });
  restarted.ensureIndex();
  expect(lastSeen(f, restarted)).toBe(AT);
  expect(restarted.read()?.records).toEqual(file.records);
});

test.each(["client", "admitter"] as const)(
  "a removed %s cannot refresh a session time or remain in current status",
  async (target) => {
    const f = clients();
    await accept(f, "roster");
    expect(lastSeen(f)).toBeNumber();
    f.a.mesh.sign(f.a.m.identity, (n, prev) => ({
      v: 2,
      mesh: f.mesh,
      type: "revoke",
      by: signPubOf(f.a.m),
      n,
      prev,
      subject: { signPubs: [signPubOf(target === "client" ? f.c.m : f.a.m)], reason: "revoke" },
    }));
    const before = f.a.mesh.read();
    expect(await accept(f, "push")).toBeUndefined();
    expect(status(f)?.members.some((member) => member.hostId === f.c.m.identity.hostId)).toBe(false);
    expect(f.a.mesh.read()).toEqual(before);
  },
);

test("a paired roster session records its client time when the signed card establishes the identity", async () => {
  const f = fixture();
  f.devices.add(f.c.m.identity.noise.publicKey, "browser");
  const dial = await open(f, "roster");
  const client = new MeshLines(required(dial.joined), ["offer", "records", "done", "refused"]);
  f.host.roster(required(dial.host));
  const offer = await client.next();
  if (offer.t !== "offer") throw new Error("no roster offer");
  const clock = spyOn(Date, "now").mockReturnValue(AT);
  try {
    client.send({
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
    });
    expect((await client.next()).t).toBe("records");
    expect((await client.next()).t).toBe("done");
  } finally {
    clock.mockRestore();
  }
  const current = storedMeshStatus(f.a.mesh, f.a.m.identity, IDLE_MESH_HOOKS);
  expect(current?.members.find((member) => member.hostId === f.c.m.identity.hostId)?.lastSessionAt).toBe(AT);
});

test("a later roster card does not change the time its current client's session was accepted", async () => {
  const f = clients();
  const clock = spyOn(Date, "now").mockReturnValue(AT);
  try {
    const dial = await open(f, "roster");
    clock.mockReturnValue(AT + 1000);
    const client = new MeshLines(required(dial.joined), ["offer", "records", "done", "refused"]);
    f.host.roster(required(dial.host));
    const offer = await client.next();
    if (offer.t !== "offer") throw new Error("no roster offer");
    client.send({
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
    });
    expect((await client.next()).t).toBe("records");
    expect((await client.next()).t).toBe("done");
    expect(lastSeen(f)).toBe(AT);
  } finally {
    clock.mockRestore();
  }
});
