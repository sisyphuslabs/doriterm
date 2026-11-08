import { describe, expect, test } from "bun:test";
import { meshFileJson, newMeshFile, parseMeshFile } from "./mesh-file.ts";

const record = { body: "body", sig: "sig" };

describe("the mesh file format guard", () => {
  test("a fresh file is written in the format a v2 reader accepts", () => {
    expect(meshFileJson(newMeshFile("mesh-1", [record], 1)).version).toBe(2);
  });

  test("this build reads both its own format and the next one", () => {
    for (const version of [2, 3]) {
      const file = parseMeshFile({ version, meshId: "m", generation: 1, self: { n: 1 }, records: [record] });
      expect(file.version).toBe(version);
    }
  });

  test("a format above what this build reads is refused before anything else runs", () => {
    expect(() => parseMeshFile({ version: 4, meshId: "m", generation: 1, self: { n: 1 }, records: [record] })).toThrow(
      "mesh.json: unsupported format",
    );
  });

  test("a format below what this build reads is refused too", () => {
    expect(() => parseMeshFile({ version: 1, meshId: "m", generation: 1, self: { n: 1 }, records: [record] })).toThrow(
      "mesh.json: unsupported format",
    );
  });

  test("a parsed file keeps its version, so a rewrite never silently downgrades it", () => {
    const parsed = parseMeshFile({ version: 3, meshId: "m", generation: 7, self: { n: 3 }, records: [record] });
    expect(meshFileJson(parsed).version).toBe(3);
  });

  test("a member's kind survives a persisted index, and an index that predates kinds reads as a machine", () => {
    const client = { signPub: "s", hostId: "h", noisePub: "n", name: "phone", hcId: "c", kind: "client" };
    const withKind = parseMeshFile({
      version: 3,
      meshId: "m",
      generation: 1,
      self: { n: 1 },
      records: [record],
      index: { generation: 1, members: [client], revoked: [], superseded: [], named: [] },
    });
    expect(withKind.index?.members[0]?.kind).toBe("client");
    const legacy = { signPub: "s", hostId: "h", noisePub: "n", name: "box", hcId: "c" };
    const older = parseMeshFile({
      version: 2,
      meshId: "m",
      generation: 1,
      self: { n: 1 },
      records: [record],
      index: { generation: 1, members: [legacy], revoked: [], superseded: [], named: [] },
    });
    expect(older.index?.members[0]?.kind).toBe("machine");
  });
});
