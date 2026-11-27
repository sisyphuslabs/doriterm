import { base64urlEncode } from "@doriface/crypto";
import type { ByteLink } from "@doriface/relay-client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RestoreBlobs } from "../../host/src/restore/blobs.ts";
import { RestoreService } from "../../host/src/restore/service.ts";
import { MeshStore } from "../../host/src/state/mesh.ts";
import { type RestoreLocator, sealLocator, wrapCard } from "../src/restore/blobs.ts";
import { lookupFor } from "../src/restore/keys.ts";
import { browserMeshFixture } from "./browser-mesh-fixture.ts";

interface Connection {
  readonly service: RestoreService;
  readonly readers: Set<(data: Uint8Array) => void>;
  readonly closers: Set<(error: Error | undefined) => void>;
}

const fixture = browserMeshFixture();
const { signPub: old, meshId, records } = fixture.membership;
const p0 = new Uint8Array(32).fill(7);
const r_e = new Uint8Array(32).fill(13);
const root = mkdtempSync(join(tmpdir(), "restore-holders-"));
const hosts = new Map<string, { readonly service: RestoreService; readonly mesh: MeshStore }>();
const server = Bun.serve<Connection>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, listener) {
    const [, method, hostId] = new URL(request.url).pathname.split("/");
    if (method === "snapshot" && hostId !== undefined)
      return Response.json(hosts.get(hostId)?.mesh.read()?.records ?? []);
    const restore = /^\/v1\/restore\/([a-z2-7]{26})$/.exec(new URL(request.url).pathname)?.[1];
    const service = restore === undefined ? undefined : hosts.get(restore)?.service;
    if (
      service !== undefined &&
      listener.upgrade(request, { data: { service, readers: new Set(), closers: new Set() } })
    )
      return undefined;
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(socket) {
      const { service, readers, closers } = socket.data;
      const wire: ByteLink = {
        send: (data) => {
          socket.send(data);
        },
        close: () => socket.close(),
        onData: (read) => {
          readers.add(read);
          return () => readers.delete(read);
        },
        onClose: (read) => {
          closers.add(read);
          return () => closers.delete(read);
        },
      };
      void service.anonymous(wire);
    },
    message(socket, message) {
      if (typeof message !== "string") for (const read of socket.data.readers) read(message);
    },
    close(socket) {
      for (const close of socket.data.closers) close(undefined);
    },
  },
});
const stop = () => {
  void server.stop(true).finally(() => rmSync(root, { recursive: true, force: true }));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  const machines = [fixture.holder, fixture.secondHolder];
  const locator: RestoreLocator = {
    v: 1,
    epoch: 1,
    r_e,
    relayUrl: server.url.origin,
    holders: machines.map((identity) => ({
      hostId: identity.hostId,
      hostKey: base64urlEncode(identity.noise.publicKey),
    })),
  };
  await Promise.all(
    machines.map(async (identity) => {
      const { hostId } = identity;
      const dir = mkdtempSync(join(root, "holder-"));
      const mesh = new MeshStore(dir, { log: () => undefined, durable: false });
      if (!mesh.adopt(records, identity)) throw new Error("fixture holder did not adopt the mesh");
      const lookup = await lookupFor(p0, locator, hostId);
      const blob = await wrapCard(p0, { ...locator, version: 1, hostId, meshId }, fixture.browser.sign.secretKey);
      const owner = { signPub: old, devicePub: base64urlEncode(fixture.browser.noise.publicKey) };
      if (!new RestoreBlobs(dir).put(owner, { lookup, version: 1, epoch: 1, blob }, Date.now()))
        throw new Error("fixture could not enroll");
      const service = new RestoreService({
        identity,
        mesh,
        stateDir: dir,
        sessions: { has: () => false },
        sync: { formatReady: () => true, changed: () => undefined },
      });
      hosts.set(hostId, { mesh, service });
    }),
  );
  console.log(
    JSON.stringify({
      url: server.url.origin,
      holderIds: [...hosts.keys()],
      locator: [...(await sealLocator(p0, locator))],
      records,
      old,
    }),
  );
} catch (cause) {
  stop();
  throw cause;
}
