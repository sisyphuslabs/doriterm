import { HcRpcError, isJsonObject, type JsonValue, MESH_STATUS_DOC } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { meshFixture } from "../testing/mesh-fixture.ts";
import { type DocStore, publishMeshStatus } from "./status-doc.ts";
import { meshStatus } from "./status.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const status = meshStatus(meshFixture(NOW).sources, NOW);

/** herdr's document semantics: a set must name the current version, and every write bumps it. */
class Docs implements DocStore {
  value: JsonValue = null;
  version = 0;
  sets = 0;
  /** Writes another client makes right after each of our reads, before our set lands. */
  racing: JsonValue[] = [];
  /** When set, the next set waits for it; `held` resolves once that set has been called. */
  hold: Promise<void> | undefined;
  readonly held = Promise.withResolvers<void>();

  async get(name: string) {
    expect(name).toBe(MESH_STATUS_DOC);
    const reply = { value: this.value, version: this.version };
    const other = this.racing.shift();
    if (other !== undefined) {
      this.value = other;
      this.version += 1;
    }
    return reply;
  }

  async set(name: string, value: JsonValue, version: number) {
    expect(name).toBe(MESH_STATUS_DOC);
    this.sets += 1;
    const hold = this.hold;
    this.hold = undefined;
    if (hold !== undefined) {
      this.held.resolve();
      await hold;
    }
    if (version !== this.version)
      throw new HcRpcError({ code: -32000, message: "conflict", data: { kind: "conflict" } });
    this.value = value;
    this.version += 1;
    return { version: this.version };
  }
}

describe("publishing the status document", () => {
  test("writes the status at the current version", async () => {
    const docs = new Docs();
    expect(await publishMeshStatus(docs, () => status)).toBe("written");
    expect(docs.value).toEqual(status);
    expect(docs.version).toBe(1);
  });

  test("leaves a document that already holds the status alone, whatever its key order", async () => {
    const docs = new Docs();
    docs.value = Object.fromEntries(Object.entries(status).toReversed());
    expect(await publishMeshStatus(docs, () => status)).toBe("unchanged");
    expect(docs.sets).toBe(0);
  });

  test("a client that wrote between our read and our write: read again and write at the new version", async () => {
    const docs = new Docs();
    docs.racing = [{ approve: "someone else" }];
    expect(await publishMeshStatus(docs, () => status)).toBe("written");
    expect(docs.value).toEqual(status);
    expect(docs.sets).toBe(2);
  });

  test("two publishes on one host: the newer status survives the older one's set landing late", async () => {
    const docs = new Docs();
    const gate = Promise.withResolvers<void>();
    docs.hold = gate.promise;
    let generation = 41;
    const current = () => ({ ...status, generation });
    const older = publishMeshStatus(docs, current);
    await docs.held.promise;
    generation = 42;
    expect(await publishMeshStatus(docs, current)).toBe("written");
    gate.resolve();
    expect(await older).toBe("unchanged");
    expect(isJsonObject(docs.value) ? docs.value["generation"] : undefined).toBe(42);
  });

  test("gives up with the conflict after three racing writers in a row", async () => {
    const docs = new Docs();
    docs.racing = [1, 2, 3];
    const failed = await publishMeshStatus(docs, () => status).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(HcRpcError);
    expect(docs.sets).toBe(3);
    expect(docs.value).toBe(3);
  });

  test("the attempt bound is not a parameter a caller can turn off", async () => {
    const docs = new Docs();
    docs.racing = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // @ts-expect-error the attempt counter is internal: publishMeshStatus takes no third argument
    const failed = await publishMeshStatus(docs, () => status, Number.NaN).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(HcRpcError);
    expect(docs.sets).toBe(3);
  });

  test("any other refusal is not retried", async () => {
    let sets = 0;
    const refusing: DocStore = {
      get: async () => ({ value: null, version: 0 }),
      set: async () => {
        sets += 1;
        throw new HcRpcError({ code: -32000, message: "unavailable", data: { kind: "unavailable" } });
      },
    };
    await expect(publishMeshStatus(refusing, () => status)).rejects.toThrow("unavailable");
    expect(sets).toBe(1);
  });
});
