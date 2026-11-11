import { HcConnection } from "@doriface/client";
import { type JsonValue, MESH_STATUS_DOC } from "@doriface/protocol";
import { expect, test } from "bun:test";
import { meshFixture } from "../testing/mesh-fixture.ts";
import { createHcSession } from "../testing/hc-session.ts";
import { spawnHcLink } from "./hc-machines.ts";
import { publishMeshStatusOnCore } from "./status-publisher.ts";
import { meshStatus } from "./status.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const status = meshStatus(meshFixture(NOW).sources, NOW);

/** A cadence no test waits on: each test asks for its ticks and the timer never fires under it. */
const NEVER = 3_600_000;

async function withCore<T>(session: ReturnType<typeof createHcSession>, use: (core: HcConnection) => Promise<T>) {
  const link = spawnHcLink({ hc: session.hc, session: session.name, env: session.env });
  const core = await HcConnection.open(link);
  try {
    return await use(core);
  } finally {
    core.close();
    link.close();
  }
}

const docOf = (session: ReturnType<typeof createHcSession>): Promise<{ value: JsonValue; version: number }> =>
  withCore(session, async (core) => core.call("doc.get", { name: MESH_STATUS_DOC }));

test("a tick writes the host's status on its core, over a child that has exited once it settled", async () => {
  const session = createHcSession("dh-mesh-publish");
  const target = { hc: session.hc, session: session.name, env: session.env };
  let exited = false;
  const publisher = publishMeshStatusOnCore(
    target,
    () => status,
    status.self,
    () => {},
    (core) => {
      const link = spawnHcLink(core);
      link.onClose(() => (exited = true));
      return link;
    },
    NEVER,
  );
  try {
    await publisher.settled();
    expect(await docOf(session)).toMatchObject({ value: status, version: 1 });
    expect(exited).toBe(true);
  } finally {
    await publisher.stop();
    await session.dispose();
  }
}, 30_000);

test("a status that did not change writes nothing; one that did is written on the next tick", async () => {
  const session = createHcSession("dh-mesh-publish-twice");
  let generation = 41;
  const publisher = publishMeshStatusOnCore(
    { hc: session.hc, session: session.name, env: session.env },
    () => ({ ...status, generation }),
    status.self,
    () => {},
    spawnHcLink,
    NEVER,
  );
  try {
    await publisher.tick();
    expect(await docOf(session)).toMatchObject({ version: 1 });
    await publisher.tick();
    expect(await docOf(session)).toMatchObject({ version: 1 });
    generation = 42;
    await publisher.tick();
    const after = await docOf(session);
    expect(after.version).toBe(2);
    expect(after.value).toMatchObject({ generation: 42 });
  } finally {
    await publisher.stop();
    await session.dispose();
  }
}, 30_000);

test("each tick reads herdr's lines again before it publishes, so the document carries what the refresh found (#1239)", async () => {
  const session = createHcSession("dh-mesh-publish-refresh");
  let refreshes = 0;
  const publisher = publishMeshStatusOnCore(
    { hc: session.hc, session: session.name, env: session.env },
    () => ({ ...status, generation: refreshes }),
    status.self,
    () => {},
    spawnHcLink,
    NEVER,
    () => {
      refreshes += 1;
      return Promise.resolve();
    },
  );
  try {
    await publisher.settled();
    expect(await docOf(session)).toMatchObject({ value: { generation: 1 }, version: 1 });
    await publisher.tick();
    expect(await docOf(session)).toMatchObject({ value: { generation: 2 }, version: 2 });
  } finally {
    await publisher.stop();
    await session.dispose();
  }
}, 30_000);

test("a host in no mesh clears the document the mesh it left had written", async () => {
  const session = createHcSession("dh-mesh-publish-clear");
  await withCore(session, (core) => core.call("doc.set", { name: MESH_STATUS_DOC, value: status, version: 0 }));
  const publisher = publishMeshStatusOnCore(
    { hc: session.hc, session: session.name, env: session.env },
    () => undefined,
    status.self,
    () => {},
    spawnHcLink,
    NEVER,
  );
  try {
    await publisher.tick();
    expect(await docOf(session)).toMatchObject({ value: null });
  } finally {
    await publisher.stop();
    await session.dispose();
  }
}, 30_000);

test("a document another host wrote is never cleared, so a seeded fixture survives", async () => {
  const session = createHcSession("dh-mesh-publish-foreign");
  await withCore(session, (core) => core.call("doc.set", { name: MESH_STATUS_DOC, value: status, version: 0 }));
  const publisher = publishMeshStatusOnCore(
    { hc: session.hc, session: session.name, env: session.env },
    () => undefined,
    "a-host-that-is-not-in-this-mesh",
    () => {},
    spawnHcLink,
    NEVER,
  );
  try {
    await publisher.tick();
    await publisher.tick();
    expect(await docOf(session)).toMatchObject({ value: status, version: 1 });
  } finally {
    await publisher.stop();
    await session.dispose();
  }
}, 30_000);

test("a core that cannot be reached is logged once, not on every tick", async () => {
  const logs: string[] = [];
  const publisher = publishMeshStatusOnCore(
    { hc: "/nonexistent/hc-for-this-test", env: {} },
    () => status,
    status.self,
    (line) => logs.push(line),
    spawnHcLink,
    NEVER,
  );
  try {
    await publisher.tick();
    await publisher.tick();
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("cannot write this host's mesh status on its core");
    expect(publisher.kill()).toEqual([]);
  } finally {
    await publisher.stop();
  }
}, 30_000);
