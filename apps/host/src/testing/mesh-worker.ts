import { base64urlDecode, base64urlEncode, hostIdentityFromSecrets } from "@doriface/crypto";
import type { Signed } from "@doriface/mesh";
import { readFileSync } from "node:fs";
import { MeshStore } from "../state/mesh.ts";

/**
 * A separate process for the transaction race test, one transaction per step:
 * `ack <dir> <meshId> <signSecret> <noiseSecret> <count>` signs `count` acks as that host;
 * `merge <dir> <records.json>` merges each record of the file in its own transaction.
 */
const [op, dir, ...rest] = process.argv.slice(2);
if (dir === undefined) throw new Error("usage: mesh-worker ack|merge <dir> ...");
const store = new MeshStore(dir, { log: () => {}, lockTimeoutMs: 30_000 });
if (op === "ack") {
  const [meshId, signSecret, noiseSecret, count] = rest;
  if (meshId === undefined || signSecret === undefined || noiseSecret === undefined) throw new Error("ack arguments");
  const identity = hostIdentityFromSecrets(base64urlDecode(signSecret), base64urlDecode(noiseSecret));
  const by = base64urlEncode(identity.sign.publicKey);
  for (let i = 0; i < Number(count); i++) {
    store.transact((tx) => tx.sign(identity, (n, prev) => ({ v: 2, mesh: meshId, type: "ack", by, n, prev })));
  }
} else if (op === "merge") {
  const [path] = rest;
  if (path === undefined) throw new Error("merge arguments");
  const records: readonly Signed[] = JSON.parse(readFileSync(path, "utf8"));
  for (const record of records) {
    const { added } = store.transact((tx) => tx.merge([record]));
    if (added.length !== 1) throw new Error("a record was not merged");
  }
} else throw new Error(`unknown op ${String(op)}`);
