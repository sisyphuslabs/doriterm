import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceOf, machine, MeshFixture, noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { writePrivateJson } from "./files.ts";
import { MeshStore } from "./mesh.ts";
import { meshFileJson, parseMeshFile } from "./mesh-file.ts";

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dh-mesh-index-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fileOf = (dir: string) => parseMeshFile(JSON.parse(readFileSync(join(dir, "mesh.json"), "utf8")));
const own = (m: ReturnType<typeof machine>) => ({ name: m.name, hcId: m.hcId, devicePub: deviceOf(m) });

describe("MEDIUM-2: the authorize index is never reused across a replaced mesh.json", () => {
  test("mesh A's founder re-founds as mesh B: A's founder is not a member of B", () => {
    const dir = scratch();
    const [a, b] = [machine("a"), machine("b")];
    const store = new MeshStore(dir, { log: () => {} });
    store.found(a.identity, own(a));
    expect(store.authorizeIndex()?.member(noiseOf(a))).toBeDefined();
    rmSync(join(dir, "mesh.json"));
    store.found(b.identity, own(b));
    const index = store.authorizeIndex();
    expect(index?.generation).toBe(1);
    expect(index?.member(noiseOf(a))).toBeUndefined();
    expect(index?.member(noiseOf(b))).toBeDefined();
  });

  test("the same mesh adopted again at generation 1, with a member since revoked: the revoke holds", () => {
    const [founder, host, gone] = [machine("founder"), machine("host"), machine("gone")];
    const sourceDir = scratch();
    const source = new MeshFixture(sourceDir, founder);
    source.admit(founder, host);
    source.admit(founder, gone);
    const before = fileOf(sourceDir).records;
    source.revoke(founder, gone);
    const after = fileOf(sourceDir).records;
    const dir = scratch();
    const store = new MeshStore(dir, { log: () => {} });
    store.adopt(before, host.identity);
    expect(store.authorizeIndex()?.member(noiseOf(gone))).toBeDefined();
    rmSync(join(dir, "mesh.json"));
    store.adopt(after, host.identity);
    expect(store.authorizeIndex()?.generation).toBe(1);
    expect(store.authorizeIndex()?.member(noiseOf(gone))).toBeUndefined();
    expect(store.authorizeIndex()?.deviceRefusal(noiseOf(gone))).toBe("revoked mesh member");
  });
});

describe("MEDIUM-1: writing the counter never re-tags a stale index as current", () => {
  test("a stale index naming a ghost member, then a crash after the counter write: the ghost is no member", () => {
    const dir = scratch();
    const founder = machine("founder");
    const ghost = machine("ghost");
    const mesh = new MeshFixture(dir, founder);
    const file = fileOf(dir);
    if (file.index === undefined) throw new Error("no index");
    const ghostEntry = {
      signPub: signPubOf(ghost),
      hostId: ghost.identity.hostId,
      noisePub: noiseOf(ghost),
      devicePub: undefined,
      name: "ghost",
      hcId: ghost.hcId,
      kind: "machine" as const,
    };
    const stale = { ...file.index, generation: file.generation - 1, members: [...file.index.members, ghostEntry] };
    writePrivateJson(join(dir, "mesh.json"), meshFileJson({ ...file, index: stale }));
    expect(() =>
      mesh.store.sign(founder.identity, () => {
        throw new Error("crashed while signing");
      }),
    ).toThrow("crashed");
    const index = new MeshStore(dir, { log: () => {} }).authorizeIndex();
    expect(index?.member(noiseOf(ghost))).toBeUndefined();
    expect(index?.member(noiseOf(founder))).toBeDefined();
  });
});
