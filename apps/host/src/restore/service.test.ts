import { expect, test } from "bun:test";
import { createMemoryLinkPair } from "@doriface/client";
import {
  base64urlEncode,
  decodeRestoreFrame,
  encodeRestoreFrame,
  openRestoreNoise,
  RESTORE_RESPONSE_BYTES,
  RESTORE_SECOND_BYTES,
} from "@doriface/crypto";
import { signCard, signReadmit } from "@doriface/mesh";
import { cardBodyFor } from "@doriface/mesh/join";
import { readRestoreMessage } from "@doriface/relay-client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machine, MeshFixture, noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { RestoreBlobs } from "./blobs.ts";
import { RestoreService } from "./service.ts";

async function requestAt(service: RestoreService, holder: Uint8Array, request: unknown): Promise<unknown> {
  const [client, server] = createMemoryLinkPair();
  const done = service.anonymous(server);
  try {
    const nk = openRestoreNoise(holder);
    const second = await readRestoreMessage(client, RESTORE_SECOND_BYTES, () => client.send(nk.first));
    const { receive, send } = nk.finish(second);
    const empty = new Uint8Array(0);
    const frame = encodeRestoreFrame("request", request);
    const reply = await readRestoreMessage(client, RESTORE_RESPONSE_BYTES, () =>
      client.send(send.encryptWithAd(empty, frame)),
    );
    return decodeRestoreFrame("response", receive.decryptWithAd(empty, reply)).json;
  } finally {
    client.close();
    await done;
  }
}

test("M10: only an exact signed retry receives the same holder's readmission receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-receipt-"));
  try {
    const holder = machine("studio");
    const old = machine("phone");
    const fresh = machine("restored");
    const mesh = new MeshFixture(dir, holder);
    const card = signCard(
      cardBodyFor(
        { ...old.identity, noisePub: old.identity.noise.publicKey },
        { name: old.name, hcId: "", devicePub: noiseOf(old) },
        { mesh: mesh.meshId, inviter: signPubOf(holder), kind: "client" },
      ),
      old.identity.sign.secretKey,
    );
    const admit = mesh.next(holder, "admit", { card });
    mesh.store.sign(holder.identity, (n, prev) => ({ ...admit, n, prev }));
    const lookup = base64urlEncode(new Uint8Array(32).fill(5));
    expect(
      new RestoreBlobs(dir).put(
        { signPub: signPubOf(old), devicePub: noiseOf(old) },
        { lookup, version: 1, epoch: 1, blob: new Uint8Array(4096) },
        Date.now(),
      ),
    ).toBe(true);
    const service = new RestoreService({
      identity: holder.identity,
      stateDir: dir,
      mesh: mesh.store,
      sessions: { has: () => false },
      sync: { changed: () => {}, formatReady: () => true },
    });
    const fields = {
      old: signPubOf(old),
      signPub: signPubOf(fresh),
      noise: noiseOf(fresh),
      name: "phone",
      nonce: base64urlEncode(new Uint8Array(16).fill(9)),
      at: 1_795_747_200_000,
    };
    const proof = {
      ...fields,
      oldSig: signReadmit(mesh.meshId, fields, old.identity.sign.secretKey),
      newSig: signReadmit(mesh.meshId, fields, fresh.identity.sign.secretKey),
    };
    const request = { t: "readmit", lookup, proof };
    const ask = (sent: unknown) => requestAt(service, holder.identity.noise.publicKey, sent);
    const admission = await ask(request);
    expect(admission).toMatchObject({ t: "admitted" });
    expect(await ask(request)).toEqual(admission);
    expect(await ask({ ...request, proof: { ...proof, name: "other-phone" } })).toBeNull();
    expect(mesh.store.read()?.records).toHaveLength(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function restoreWith(opts: { readonly formatReady: boolean; readonly olderClient: boolean }): Promise<{
  readonly reply: unknown;
  readonly records: number;
}> {
  const dir = mkdtempSync(join(tmpdir(), "restore-m12-"));
  try {
    const holder = machine("studio");
    const old = machine("phone");
    const tablet = machine("tablet");
    const fresh = machine("restored");
    const mesh = new MeshFixture(dir, holder);
    const admitClient = (client: ReturnType<typeof machine>): void => {
      const card = signCard(
        cardBodyFor(
          { ...client.identity, noisePub: client.identity.noise.publicKey },
          { name: client.name, hcId: "", devicePub: noiseOf(client) },
          { mesh: mesh.meshId, inviter: signPubOf(holder), kind: "client" },
        ),
        client.identity.sign.secretKey,
      );
      const admit = mesh.next(holder, "admit", { card });
      mesh.store.sign(holder.identity, (n, prev) => ({ ...admit, n, prev }));
    };
    admitClient(old);
    if (opts.olderClient) admitClient(tablet);
    const lookup = base64urlEncode(new Uint8Array(32).fill(6));
    new RestoreBlobs(dir).put(
      { signPub: signPubOf(old), devicePub: noiseOf(old) },
      { lookup, version: 1, epoch: 1, blob: new Uint8Array(4096) },
      Date.now(),
    );
    const service = new RestoreService({
      identity: holder.identity,
      stateDir: dir,
      mesh: mesh.store,
      sessions: { has: () => false },
      sync: { changed: () => {}, formatReady: () => opts.formatReady },
    });
    const fields = {
      old: signPubOf(old),
      signPub: signPubOf(fresh),
      noise: noiseOf(fresh),
      name: "phone",
      nonce: base64urlEncode(new Uint8Array(16).fill(7)),
      at: 1_795_747_200_000,
    };
    const proof = {
      ...fields,
      oldSig: signReadmit(mesh.meshId, fields, old.identity.sign.secretKey),
      newSig: signReadmit(mesh.meshId, fields, fresh.identity.sign.secretKey),
    };
    const reply = await requestAt(service, holder.identity.noise.publicKey, { t: "readmit", lookup, proof });
    return { reply, records: mesh.store.read()?.records.length ?? 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("M12: a mesh with a machine that does not read the readmit format falls back to an invite and publishes nothing", async () => {
  const { reply, records } = await restoreWith({ formatReady: false, olderClient: false });
  expect(reply).toEqual({ t: "invite" });
  expect(records).toBe(2);
});

test("M12: a client member that never advertised readmit support makes the restore fall back to an invite, not wait", async () => {
  const { reply, records } = await restoreWith({ formatReady: true, olderClient: true });
  expect(reply).toEqual({ t: "invite" });
  expect(records).toBe(3);
});
