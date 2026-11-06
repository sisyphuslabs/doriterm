import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcConnection } from "@doriface/client";
import { generateX25519 } from "@doriface/crypto";
import { type JsonValue, MESH_STATUS_DOC, parseMeshStatus } from "@doriface/protocol";
import { generateToken } from "../auth.ts";
import { requestControl } from "../control.ts";
import { type Host, startHost } from "../host.ts";
import { loadHostIdentity } from "../state/host-keys.ts";
import { createHcSession, HELLO, type HcSession } from "../testing/hc-session.ts";
import { type Machine, machine, MeshFixture } from "../testing/mesh-history.ts";
import { meshFixture } from "../testing/mesh-fixture.ts";
import { meshStatus } from "./status.ts";
import { openWsClient, type WsClient } from "../testing/ws-client.ts";
import { spawnHcLink } from "./hc-machines.ts";

const dirs: string[] = [];
/** Each host's start, held from the call: a test that times out mid-start still stops the host that comes up later. */
const hosts: Promise<Host | undefined>[] = [];
const sessions: HcSession[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(async (started) => (await started)?.stop()));
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A host on its own scratch core: reading its core id would otherwise start the default session's core and leave it. */
async function hostIn(dir: string): Promise<{ host: Host; token: string; session: HcSession }> {
  const session = createHcSession("host-mesh");
  sessions.push(session);
  const token = generateToken();
  // A start the test outlives would bring this session's core back after its dispose, with nothing to stop it.
  const started = startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token,
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir: dir,
    log: () => {},
  });
  hosts.push(started.catch(() => undefined));
  return { host: await started, token, session };
}

/** A client's pipe is what starts the host's document writes; a hello on it changes nothing for them. */
async function openPipeOf(host: Host, token: string): Promise<WsClient> {
  const client = await openWsClient(host.url, token);
  // The hello's reply travels through the host's pipe, so the pipe is open once it arrives.
  client.socket.send(HELLO);
  await client.reader.line();
  return client;
}

/** The core's document, read the way a client reads it: over a link of its own, not through the host under test. */
async function docValue(session: HcSession): Promise<JsonValue> {
  const link = spawnHcLink({ hc: session.hc, session: session.name, env: session.env });
  const core = await HcConnection.open(link);
  try {
    return (await core.call("doc.get", { name: MESH_STATUS_DOC })).value;
  } finally {
    core.close();
    link.close();
  }
}

function meshHere(): { dir: string; self: Machine; mesh: MeshFixture } {
  const dir = mkdtempSync(join(tmpdir(), "dh-host-mesh-"));
  dirs.push(dir);
  const self = { identity: loadHostIdentity(dir), device: generateX25519(), name: "studio", hcId: "core-studio" };
  return { dir, self, mesh: new MeshFixture(dir, self) };
}

const statusOf = async (dir: string) => parseMeshStatus(await requestControl(dir, { op: "mesh-status" }));

describe("the running host answers mesh status from its mesh.json", () => {
  test("a host with no mesh still answers null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dh-host-mesh-"));
    dirs.push(dir);
    await hostIn(dir);
    expect(await requestControl(dir, { op: "mesh-status" })).toBeNull();
  });

  test("a member's status lists itself and the members its view holds", async () => {
    const { dir, self, mesh } = meshHere();
    const laptop = machine("laptop");
    mesh.admit(self, laptop);
    await hostIn(dir);
    const status = await statusOf(dir);
    expect(status?.meshId).toBe(mesh.meshId);
    expect(status?.self).toBe(self.identity.hostId);
    expect(status?.members.map((member) => [member.name, member.line, member.admittedBy])).toEqual([
      ["studio", "self", null],
      ["laptop", "absent", self.identity.hostId],
    ]);
  });

  test("a revoke and a rename through the control socket show in the next status", async () => {
    const { dir, self, mesh } = meshHere();
    const [laptop, tablet] = [machine("laptop"), machine("tablet")];
    mesh.admit(self, laptop);
    mesh.admit(self, tablet);
    mesh.record(laptop, "ack");
    mesh.store.catchUp(self.identity);
    await hostIn(dir);
    await requestControl(dir, { op: "mesh-rename", member: "tablet", name: "pad" });
    const reply = await requestControl(dir, { op: "mesh-revoke", member: "laptop", compromised: false, yes: true });
    expect(reply).toMatchObject({ written: true });
    const status = await statusOf(dir);
    expect(status?.members.map((member) => member.name)).toEqual(["studio", "pad"]);
    expect(status?.revoked.map((member) => [member.name, member.reason, member.revokedBy])).toEqual([
      ["laptop", "revoke", [self.identity.hostId]],
    ]);
  });

  test("a client's pipe puts the mesh this host runs on its core, where any client reads it", async () => {
    const { dir, self, mesh } = meshHere();
    mesh.admit(self, machine("laptop"));
    const { host, token, session } = await hostIn(dir);
    const client = await openPipeOf(host, token);
    try {
      await host.meshStatusSettled();
      expect(await docValue(session)).toMatchObject({ meshId: mesh.meshId, self: self.identity.hostId });
    } finally {
      client.socket.close();
    }
  });

  test("a host that is in no mesh clears the document a mesh it left had written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dh-host-mesh-"));
    dirs.push(dir);
    // The document a mesh it left would have written: a status whose own line, and `self`, name this host.
    const own = meshStatus(meshFixture(new Date()).sources, new Date());
    const hostId = loadHostIdentity(dir).hostId;
    const members = [...own.members];
    const index = members.findIndex((member) => member.line === "self");
    const ownLine = members[index];
    if (ownLine !== undefined) members[index] = { ...ownLine, hostId };
    const left = { ...own, self: hostId, members };
    const { host, token, session } = await hostIn(dir);
    const link = spawnHcLink({ hc: session.hc, session: session.name, env: session.env });
    const core = await HcConnection.open(link);
    try {
      await core.call("doc.set", { name: MESH_STATUS_DOC, value: left, version: 0 });
    } finally {
      core.close();
      link.close();
    }
    const client = await openPipeOf(host, token);
    try {
      await host.meshStatusSettled();
      expect(await docValue(session)).toBeNull();
    } finally {
      client.socket.close();
    }
  });

  test("a host in no mesh leaves a document another host wrote untouched, the way the web e2e seeds one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dh-host-mesh-"));
    dirs.push(dir);
    // The seeded fixture names its own founder, never the host under test: that is what mesh.e2e.ts writes.
    const seeded = meshStatus(meshFixture(new Date()).sources, new Date());
    const { host, token, session } = await hostIn(dir);
    const link = spawnHcLink({ hc: session.hc, session: session.name, env: session.env });
    const core = await HcConnection.open(link);
    try {
      await core.call("doc.set", { name: MESH_STATUS_DOC, value: seeded, version: 0 });
    } finally {
      core.close();
      link.close();
    }
    const client = await openPipeOf(host, token);
    try {
      await host.meshStatusSettled();
      expect(await docValue(session)).toEqual(seeded);
    } finally {
      client.socket.close();
    }
  });
});
