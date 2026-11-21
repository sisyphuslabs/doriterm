import { signCard } from "@doriface/mesh";
import { MeshLines } from "@doriface/mesh/join";
import { parseMeshStatus } from "@doriface/protocol";
import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateJson } from "../state/files.ts";
import { withStateLock } from "../state/lock.ts";
import { cardBody, MeshStore } from "../state/mesh.ts";
import { meshFileJson } from "../state/mesh-file.ts";
import { noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { fixture, open, required } from "../testing/roster-resume-harness.ts";
import { IDLE_MESH_HOOKS } from "./host-hooks.ts";
import { storedMeshStatus } from "./status-store.ts";

import { accept, clients, status, lastSeen, clearClientSessions } from "../testing/client-session-harness.ts";

afterEach(clearClientSessions);
const AT = 1_790_000_000_000;

test("a client's session time survives the one-time rebuild of an index saved under other admission rules (#1483)", async () => {
  const f = clients();
  const clock = spyOn(Date, "now").mockReturnValue(AT);
  try {
    expect(await accept(f, undefined)).toBeDefined();
  } finally {
    clock.mockRestore();
  }
  expect(lastSeen(f)).toBe(AT);
  // As an earlier build saved it: the index has no rules version, so the next start rebuilds it from the records.
  const path = join(f.a.dir, "mesh.json");
  const saved = JSON.parse(readFileSync(path, "utf8")) as { generation: number; index: Record<string, unknown> };
  delete saved.index["rules"];
  writePrivateJson(path, saved);
  const restarted = new MeshStore(f.a.dir, { log: () => {} });
  restarted.ensureIndex();
  expect(restarted.read()?.generation).toBe(saved.generation + 1);
  expect(lastSeen(f, restarted)).toBe(AT);
});

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
    const later = spyOn(Date, "now").mockReturnValue(AT + 300_000);
    try {
      expect(await accept(f, stream)).toBeDefined();
    } finally {
      later.mockRestore();
    }
    expect(lastSeen(f, restarted)).toBe(AT + 300_000);
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

test("a busy state lock is logged and never waited on, leaving the recorded time alone", async () => {
  const f = clients();
  const clock = spyOn(Date, "now").mockReturnValue(AT);
  try {
    await accept(f, undefined);
  } finally {
    clock.mockRestore();
  }
  expect(lastSeen(f)).toBe(AT);
  const before = f.a.mesh.read();
  let waits = 0;
  const sleeps = spyOn(Bun, "sleepSync").mockImplementation(() => {
    waits += 1;
  });
  try {
    withStateLock(f.a.dir, () => {
      f.a.mesh.recordClientSession(noiseOf(f.c.m), AT + 5 * 60_000 + 1);
    });
  } finally {
    sleeps.mockRestore();
  }
  expect(waits).toBe(0);
  expect(f.a.logs).toContainEqual(expect.stringContaining("mesh: cannot record client session"));
  expect(f.a.mesh.read()).toEqual(before);
  expect(lastSeen(f)).toBe(AT);
});

test("a current client is observed only after its later roster card is accepted", async () => {
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
    expect(lastSeen(f)).toBe(AT + 1000);
  } finally {
    clock.mockRestore();
  }
});
