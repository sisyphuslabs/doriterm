import { base64urlEncode, CloseCode, rawStaticKey } from "@doriface/crypto";
import { parseRecord, type Signed, viewOf } from "@doriface/mesh";
import { afterEach, describe, expect, test } from "bun:test";
import { cpuHeadroom } from "../testing/cpu-headroom.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machine, MeshFixture, noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { pairingHost, runSession } from "../testing/pairing-harness.ts";
import { CounterBehindError, MeshStore } from "./mesh.ts";
import { meshFileJson, parseMeshFile } from "./mesh-file.ts";
import { writePrivateJson } from "./files.ts";

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dh-mesh-state-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fileOf = (dir: string) => parseMeshFile(JSON.parse(readFileSync(join(dir, "mesh.json"), "utf8")));

describe("H-2: the authorize index", () => {
  test("handshakes never evaluate the view, and another writer's merge is seen at its new generation", async () => {
    const dir = scratch();
    const [founder, member, late] = [machine("founder"), machine("member"), machine("late")];
    const writer = new MeshFixture(dir, founder);
    writer.admit(founder, member);
    let evaluations = 0;
    const counting = (records: readonly Signed[]) => {
      evaluations++;
      return viewOf(records);
    };
    const hostStore = new MeshStore(dir, { log: () => {}, evaluate: counting });
    const host = pairingHost({ dir, mesh: () => hostStore });
    const dial = async (who: typeof member) => {
      const run = runSession(host, { kind: "lan" }, undefined, { staticKey: rawStaticKey(who.identity.noise) });
      const secure = await run.host;
      await run.client;
      return secure === undefined ? run.hostEnd.closeCode : "accepted";
    };
    expect(await Promise.all([dial(member), dial(member), dial(member)])).toEqual(["accepted", "accepted", "accepted"]);
    expect(await dial(late)).toBe(CloseCode.UnknownDevice);
    const before = hostStore.authorizeIndex()?.generation;
    writer.admit(member, late);
    expect(await dial(late)).toBe("accepted");
    expect(hostStore.authorizeIndex()?.generation).toBeGreaterThan(before ?? Infinity);
    expect(evaluations).toBe(0);
  });

  test("an index that does not match the file's generation is refused, not evaluated, until the host rebuilds it", () => {
    const dir = scratch();
    const file = new MeshFixture(dir, machine("founder")).store.read();
    if (file === undefined) throw new Error("no mesh");
    writePrivateJson(join(dir, "mesh.json"), meshFileJson({ ...file, generation: file.generation + 5 }));
    let evaluations = 0;
    const store = new MeshStore(dir, {
      log: () => {},
      evaluate: (records) => {
        evaluations++;
        return viewOf(records);
      },
    });
    expect(() => store.authorizeIndex()).toThrow("stale");
    expect(evaluations).toBe(0);
    store.ensureIndex();
    expect(evaluations).toBe(1);
    expect(store.authorizeIndex()?.generation).toBe(fileOf(dir).generation);
  });

  test("an index written before it named the keys that contest a key (#90) is rebuilt at start", () => {
    const dir = scratch();
    const [founder, member] = [machine("founder"), machine("member")];
    const mesh = new MeshFixture(dir, founder);
    mesh.admit(founder, member);
    const path = join(dir, "mesh.json");
    const written = JSON.parse(readFileSync(path, "utf8")) as { index: Record<string, unknown> };
    delete written.index["named"];
    writePrivateJson(path, written);
    const store = new MeshStore(dir, { log: () => {} });
    expect(() => store.authorizeIndex()).toThrow("stale");
    store.ensureIndex();
    expect(store.authorizeIndex()?.member(noiseOf(member))?.signPub).toBe(signPubOf(member));
    expect(
      fileOf(dir)
        .index?.named.map((entry) => entry.signPub)
        .toSorted(),
    ).toEqual([signPubOf(founder), signPubOf(member)].toSorted());
  });

  test("an index saved before the client key binding (#1476) is rebuilt at start, so a mismatched client is not indexed (#1483)", () => {
    const dir = scratch();
    const [founder, member] = [machine("founder"), machine("member")];
    new MeshFixture(dir, founder).admit(founder, member);
    const path = join(dir, "mesh.json");
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      index: Record<string, unknown> & { members: unknown[] };
    };
    // As an earlier build saved it: no rules version, and a client whose device key is not its session key.
    delete written.index["rules"];
    written.index.members.push({
      signPub: "sign-phone",
      hostId: "host-phone",
      noisePub: "noise-phone",
      devicePub: "device-other",
      name: "phone",
      hcId: "hc-phone",
      kind: "client",
      admitter: signPubOf(founder),
      admitId: "admit-phone",
    });
    writePrivateJson(path, written);
    const store = new MeshStore(dir, { log: () => {} });
    store.ensureIndex();
    expect(store.authorizeIndex()?.client("device-other")).toBeUndefined();
    expect(store.authorizeIndex()?.member(noiseOf(member))?.signPub).toBe(signPubOf(member));
  });

  test("an index saved under the current rules is kept at start, not rebuilt", () => {
    const dir = scratch();
    const [founder, member] = [machine("founder"), machine("member")];
    new MeshFixture(dir, founder).admit(founder, member);
    const before = fileOf(dir).generation;
    new MeshStore(dir, { log: () => {} }).ensureIndex();
    expect(fileOf(dir).generation).toBe(before);
  });

  test("an index written under the 12-member cap (#806) is rebuilt at start, and its thirteenth member authorizes", () => {
    const dir = scratch();
    const founder = machine("founder");
    const joined = Array.from({ length: 12 }, (_, i) => machine(`m${i}`));
    new MeshFixture(dir, founder).admitAll(founder, joined);
    const path = join(dir, "mesh.json");
    const written = JSON.parse(readFileSync(path, "utf8")) as { index: { members: unknown[]; overCap?: unknown[] } };
    written.index.overCap = written.index.members.splice(12);
    writePrivateJson(path, written);
    const store = new MeshStore(dir, { log: () => {} });
    expect(() => store.authorizeIndex()).toThrow("stale");
    store.ensureIndex();
    const thirteenth = joined.at(-1) ?? founder;
    expect(store.authorizeIndex()?.member(noiseOf(thirteenth))?.signPub).toBe(signPubOf(thirteenth));
    expect("overCap" in (JSON.parse(readFileSync(path, "utf8")) as { index: object }).index).toBe(false);
  });
});

describe("H-3: counter discipline", () => {
  test("the counter is persisted before the record is signed, and the record chains on this host's own", () => {
    const dir = scratch();
    const founder = machine("founder");
    const mesh = new MeshFixture(dir, founder);
    const seen: number[] = [];
    const record = mesh.store.sign(founder.identity, (n, prev) => {
      seen.push(fileOf(dir).selfN);
      return { v: 2, mesh: mesh.meshId, type: "ack", by: signPubOf(founder), n, prev };
    });
    expect(parseRecord(record)?.n).toBe(2);
    expect(seen).toEqual([2]);
    expect(fileOf(dir).records).toContainEqual(record);
  });

  test("a host whose persisted counter is behind its own records signs nothing until it catches up", () => {
    const dir = scratch();
    const founder = machine("founder");
    const mesh = new MeshFixture(dir, founder);
    const ack = (n: number, prev: readonly string[]) =>
      ({ v: 2, mesh: mesh.meshId, type: "ack", by: signPubOf(founder), n, prev }) as const;
    mesh.store.sign(founder.identity, ack);
    mesh.store.sign(founder.identity, ack);
    const restored = { ...fileOf(dir), selfN: 1 };
    writePrivateJson(join(dir, "mesh.json"), meshFileJson(restored));
    let built = 0;
    expect(() =>
      mesh.store.sign(founder.identity, (n, prev) => {
        built++;
        return ack(n, prev);
      }),
    ).toThrow(CounterBehindError);
    expect(built).toBe(0);
    expect(fileOf(dir).records).toHaveLength(3);
    mesh.store.catchUp(founder.identity);
    expect(parseRecord(mesh.store.sign(founder.identity, ack))?.n).toBe(4);
  });

  test("a crash between persisting the counter and storing the record reuses that counter, never skipping it", () => {
    const dir = scratch();
    const founder = machine("founder");
    const mesh = new MeshFixture(dir, founder);
    expect(() =>
      mesh.store.sign(founder.identity, () => {
        throw new Error("crashed while signing");
      }),
    ).toThrow("crashed");
    expect(fileOf(dir).selfN).toBe(2);
    const record = mesh.store.sign(founder.identity, (n, prev) => ({
      v: 2,
      mesh: mesh.meshId,
      type: "ack",
      by: signPubOf(founder),
      n,
      prev,
    }));
    expect(parseRecord(record)?.n).toBe(2);
  });
});

/** The index test's machines, their keys generated once per file: key generation is setup, not the property (#149). */
const indexMachines = {
  founder: machine("founder"),
  member: machine("member"),
  others: Array.from({ length: 11 }, (_, i) => machine(`m${i}`)),
  thirteenth: machine("m11"),
};

describe("the index follows the view", () => {
  test(
    "members past the twelfth, and every key a revoked member's cards named",
    cpuHeadroom(5, () => {
      const dir = scratch();
      const { founder, member, others, thirteenth } = indexMachines;
      const mesh = new MeshFixture(dir, founder);
      mesh.admitAll(founder, [member, ...others]);
      const old = member.identity.noise;
      const fresh = { publicKey: crypto.getRandomValues(new Uint8Array(32)), secretKey: new Uint8Array(32) };
      mesh.rekey(member, fresh);
      mesh.revoke(founder, member);
      const index = mesh.store.authorizeIndex();
      const [last] = others.slice(-1);
      if (index === undefined || last === undefined) throw new Error("no index");
      expect(index.member(noiseOf(founder))?.name).toBe("founder");
      expect(index.deviceRefusal(base64urlEncode(old.publicKey))).toBe("revoked mesh member");
      expect(index.deviceRefusal(base64urlEncode(fresh.publicKey))).toBe("revoked mesh member");
      expect(index.member(noiseOf(last))).toBeDefined();
      mesh.admit(founder, thirteenth);
      const grown = mesh.store.authorizeIndex();
      expect(grown?.memberCount).toBe(13);
      expect(grown?.member(noiseOf(thirteenth))?.name).toBe("m11");
      expect(grown?.deviceRefusal(noiseOf(thirteenth))).toBeUndefined();
    }),
  );
});
