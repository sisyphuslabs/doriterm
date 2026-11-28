// #2939: a host in no mesh publishes the joins waiting on it, such as an AI agent's first connection, so its owner can
// answer them; it says nothing about a mesh, and a host in a mesh leaves the document to its status.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateHostIdentity } from "@doriface/crypto";
import { HcRpcError, type JsonValue, parseSoloJoins, SOLO_JOINS_DOC } from "@doriface/protocol";
import { MeshStore } from "../state/mesh.ts";
import { machine, MeshFixture } from "../testing/mesh-history.ts";
import { IDLE_MESH_HOOKS, type MeshHooks } from "./host-hooks.ts";
import { type DocStore, publishSoloJoins } from "./status-doc.ts";
import type { PendingJoinFact } from "./status-sources.ts";
import { storedSoloJoins } from "./status-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dh-solo-joins-"));
  dirs.push(dir);
  return dir;
};

const identity = generateHostIdentity();
const agent: PendingJoinFact = {
  nonce: "YWdlbnQtam9pbi1ub25jZQ",
  name: "claude",
  hostId: generateHostIdentity().hostId,
  noisePub: "jY0mC6VzcIQz9YY2k1Xn3vqQ6m7lN8QTrN9k0G1tEhA",
  expiresAt: new Date("2026-11-28T10:00:00.000Z"),
  kind: "agent",
  code: "123 456",
  joinerConfirmed: true,
};
const waiting = (pending: readonly PendingJoinFact[]): MeshHooks => ({
  ...IDLE_MESH_HOOKS,
  live: () => ({ ...IDLE_MESH_HOOKS.live(), pending }),
});

describe("the joins a host in no mesh publishes (#2939)", () => {
  test("are its waiting joins and this host, in a document the reader takes, and nothing about a mesh", () => {
    const solo = storedSoloJoins(new MeshStore(tempDir(), { log: () => undefined }), identity, waiting([agent]));
    expect(solo).toEqual({
      v: 1,
      self: identity.hostId,
      pending: [
        {
          nonce: agent.nonce,
          name: "claude",
          hostId: agent.hostId,
          fingerprint: expect.any(String),
          expiresAt: "2026-11-28T10:00:00.000Z",
          kind: "agent",
          code: "123 456",
          joinerConfirmed: true,
        },
      ],
    });
    expect(parseSoloJoins(JSON.parse(JSON.stringify(solo)))).toEqual(solo);
  });

  test("are none once no join waits, which clears the document", () => {
    expect(storedSoloJoins(new MeshStore(tempDir(), { log: () => undefined }), identity, waiting([]))).toBeUndefined();
  });

  test("are none in a mesh: its status carries its joins", () => {
    const f = machine("f");
    const mesh = new MeshFixture(tempDir(), f);
    expect(storedSoloJoins(mesh.store, f.identity, waiting([agent]))).toBeUndefined();
  });
});

/** herdr's document semantics for one document: a set names the current version, and every write bumps it. */
class Doc implements DocStore {
  value: JsonValue = null;
  version = 0;
  async get(name: string) {
    expect(name).toBe(SOLO_JOINS_DOC);
    return { value: this.value, version: this.version };
  }
  async set(name: string, value: JsonValue, version: number) {
    expect(name).toBe(SOLO_JOINS_DOC);
    if (version !== this.version)
      throw new HcRpcError({ code: -32000, message: "conflict", data: { kind: "conflict" } });
    this.value = value;
    this.version += 1;
    return { version: this.version };
  }
}

describe("publishing the solo joins document", () => {
  const solo = { v: 1 as const, self: identity.hostId, pending: [] };

  test("writes the joins, then clears its own document once none waits", async () => {
    const doc = new Doc();
    expect(await publishSoloJoins(doc, () => solo, identity.hostId)).toBe("written");
    expect(doc.value).toEqual(solo);
    expect(await publishSoloJoins(doc, () => undefined, identity.hostId)).toBe("cleared");
    expect(doc.value).toBeNull();
  });

  test("leaves another host's document alone", async () => {
    const doc = new Doc();
    doc.value = { ...solo, self: "someone-else" };
    expect(await publishSoloJoins(doc, () => undefined, identity.hostId)).toBe("unchanged");
    expect(doc.value).toEqual({ ...solo, self: "someone-else" });
  });
});
