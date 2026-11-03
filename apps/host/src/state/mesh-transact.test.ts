import { base64urlEncode } from "@doriface/crypto";
import { hashOf, MAX_DANGLING, parseRecord, type Signed, signRecord } from "@doriface/mesh";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardFor, type Machine, machine, MeshFixture, noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { MeshStore } from "./mesh.ts";
import { writePrivateJson } from "./files.ts";
import { meshFileJson, parseMeshFile } from "./mesh-file.ts";

const WORKER = join(import.meta.dir, "../testing/mesh-worker.ts");
const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dh-mesh-tx-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fileOf = (dir: string) => parseMeshFile(JSON.parse(readFileSync(join(dir, "mesh.json"), "utf8")));
const ack = (mesh: MeshFixture, by: Machine): Signed => signRecord(mesh.next(by, "ack"), by.identity.sign.secretKey);
const admitOf = (mesh: MeshFixture, by: Machine, joiner: Machine): Signed =>
  signRecord(mesh.next(by, "admit", { card: cardFor(joiner, mesh.meshId, by) }), by.identity.sign.secretKey);

describe("design 3.3 step 4: a record of a signer not yet admitted waits in the persisted dangling pool", () => {
  test("held across writes, then stored when its signer's admit arrives", () => {
    const dir = scratch();
    const [founder, joiner] = [machine("founder"), machine("joiner")];
    const mesh = new MeshFixture(dir, founder);
    const early = ack(mesh, joiner);
    expect(mesh.store.merge([early])).toEqual({ added: [], refused: [], dropped: [] });
    expect(fileOf(dir).dangling).toEqual([early]);
    const admit = mesh.admit(founder, joiner);
    expect(fileOf(dir).records).toContainEqual(admit);
    expect(fileOf(dir).records).toContainEqual(early);
    expect(fileOf(dir).dangling).toEqual([]);
  });

  test(`the pool keeps at most ${MAX_DANGLING} records, the oldest dropped first`, () => {
    const dir = scratch();
    const [founder, stranger] = [machine("founder"), machine("stranger")];
    const mesh = new MeshFixture(dir, founder);
    const held = Array.from({ length: MAX_DANGLING + 1 }, (_, i) =>
      signRecord({ ...mesh.next(stranger, "ack"), n: i + 1 }, stranger.identity.sign.secretKey),
    );
    const { dropped } = mesh.store.merge(held);
    expect(dropped).toEqual(held.slice(0, 1));
    expect(fileOf(dir).dangling).toEqual(held.slice(1));
  });
});

describe("MeshStore.transact: one read-modify-write of mesh.json under the state lock (design 5.5)", () => {
  test("an admit merged and this host's ack of it are written by one commit, the ack naming the admit", () => {
    const dir = scratch();
    const [founder, member, joiner] = [machine("founder"), machine("member"), machine("joiner")];
    const mesh = new MeshFixture(dir, founder);
    mesh.admit(founder, member);
    const admit = admitOf(mesh, founder, joiner);
    const before = fileOf(dir).generation;
    const own = signPubOf(member);
    const signed = mesh.store.transact((tx) => {
      expect(tx.merge([admit]).added).toEqual([admit]);
      expect(tx.view().members.has(signPubOf(joiner))).toBe(true);
      return tx.sign(member.identity, (n, prev) => ({ v: 2, mesh: mesh.meshId, type: "ack", by: own, n, prev }));
    });
    expect(parseRecord(signed)?.prev).toContain(hashOf(admit));
    expect(fileOf(dir).records.slice(-2)).toEqual([admit, signed]);
    expect(fileOf(dir).generation).toBe(before + 2);
  });

  test("MEDIUM-4: a restored host merges its own record back and fails after the counter write: no fork of its chain", () => {
    const dir = scratch();
    const [founder, member] = [machine("founder"), machine("member")];
    const mesh = new MeshFixture(dir, founder);
    mesh.admit(founder, member);
    mesh.store.catchUp(founder.identity);
    const by = signPubOf(founder);
    const own = (n: number, prev: readonly string[]) =>
      ({ v: 2, mesh: mesh.meshId, type: "ack", by, n, prev }) as const;
    const backup = fileOf(dir);
    const sent = mesh.store.sign(founder.identity, own);
    const n = parseRecord(sent)?.n ?? 0;
    writePrivateJson(join(dir, "mesh.json"), meshFileJson({ ...backup, selfN: n }));
    expect(() =>
      mesh.store.transact((tx) => {
        tx.merge([sent]);
        return tx.sign(founder.identity, () => {
          throw new Error("crashed after the counter write");
        });
      }),
    ).toThrow("crashed");
    mesh.record(member, "ack");
    const next = mesh.store.sign(founder.identity, own);
    expect(parseRecord(next)?.n).toBe(n + 1);
    expect(fileOf(dir).records).toContainEqual(sent);
  });

  test("MEDIUM-4: the counter write after a merged admit indexes the merged records, not the ones read first", () => {
    const dir = scratch();
    const [founder, member, joiner] = [machine("founder"), machine("member"), machine("joiner")];
    const mesh = new MeshFixture(dir, founder);
    mesh.admit(founder, member);
    mesh.store.catchUp(member.identity);
    const admit = admitOf(mesh, founder, joiner);
    expect(() =>
      mesh.store.transact((tx) => {
        tx.merge([admit]);
        return tx.sign(member.identity, () => {
          throw new Error("crashed after the counter write");
        });
      }),
    ).toThrow("crashed");
    expect(new MeshStore(dir, { log: () => {} }).authorizeIndex()?.member(noiseOf(joiner))).toBeDefined();
  });

  test("a transaction that throws writes nothing it merged", () => {
    const dir = scratch();
    const [founder, member] = [machine("founder"), machine("member")];
    const mesh = new MeshFixture(dir, founder);
    const admit = admitOf(mesh, founder, member);
    const before = readFileSync(join(dir, "mesh.json"), "utf8");
    expect(() =>
      mesh.store.transact((tx) => {
        tx.merge([admit]);
        throw new Error("gave up");
      }),
    ).toThrow("gave up");
    expect(readFileSync(join(dir, "mesh.json"), "utf8")).toBe(before);
  });

  test("concurrent writers in separate processes, signing and merging, lose no update and reuse no counter", async () => {
    const dir = scratch();
    const [founder, other] = [machine("founder"), machine("other")];
    const mesh = new MeshFixture(dir, founder);
    mesh.admit(founder, other);
    mesh.store.catchUp(founder.identity);
    const chain: Signed[] = [];
    let prev = mesh.next(other, "ack").prev;
    for (let i = 0; i < 12; i++) {
      const record = signRecord({ ...mesh.next(other, "ack"), n: i + 1, prev }, other.identity.sign.secretKey);
      chain.push(record);
      prev = [hashOf(record)];
    }
    const recordsPath = join(dir, "chain.json");
    writeFileSync(recordsPath, JSON.stringify(chain));
    const initial = fileOf(dir).records.length;
    const { sign, noise } = founder.identity;
    const args = [mesh.meshId, base64urlEncode(sign.secretKey), base64urlEncode(noise.secretKey), "12"];
    const run = (...rest: string[]) =>
      Bun.spawn([process.execPath, WORKER, rest[0] ?? "", dir, ...rest.slice(1)], { stdout: "ignore", stderr: "pipe" });
    const workers = [run("ack", ...args), run("ack", ...args), run("ack", ...args), run("merge", recordsPath)];
    expect(await Promise.all(workers.map((worker) => worker.exited))).toEqual([0, 0, 0, 0]);
    const records = fileOf(dir).records;
    expect(records).toHaveLength(initial + 3 * 12 + 12);
    for (const record of chain) expect(records).toContainEqual(record);
    const founderNs = records
      .map((r) => parseRecord(r))
      .filter((b) => b?.by === signPubOf(founder))
      .map((b) => b?.n);
    expect(founderNs).toEqual(Array.from({ length: founderNs.length }, (_, i) => i + 1));
    expect(fileOf(dir).selfN).toBe(founderNs.length);
  }, 60_000);
});
