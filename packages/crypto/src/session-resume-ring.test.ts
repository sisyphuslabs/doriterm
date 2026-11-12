import { describe, expect, test } from "bun:test";
import { CloseCode, SecureLinkError } from "./link.ts";
import { RECORD_RING_BYTES } from "./record-ring.ts";
import type { SecureSession } from "./secured-link.ts";
import { CodedCloseError, memoryLinkPair, nextClose } from "./testing/memory-link.ts";
import { collect, established, flush } from "./testing/secure-link-fixture.ts";

const CHUNK = 1000;

async function resumable() {
  const session = await established();
  session.client.allowResume();
  session.server.allowResume();
  return session;
}

/** The host side of a resume: the first message on a fresh link is handed to the session, as the gateway does. */
function serve(server: SecureSession, hostEnd: ReturnType<typeof memoryLinkPair>[1]): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const unsubscribe = hostEnd.onData((first) => {
    unsubscribe();
    resolve(server.accept(hostEnd, first));
  });
  return promise;
}

const total = (chunks: readonly Uint8Array[]): number => chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);

// #2000 review: once a session has sent more than its ring holds in its life, the ring is always full, so any record
// sent while detached pushes out one the peer opened long ago. Only a record the peer can never have opened (one sent
// after the detach) being pushed out makes the session impossible to resume.
describe("a session given up after a refused resume", () => {
  test("closes with the reason it was given, unchanged, so what reads its close sees that code and not the cause's", async () => {
    const { client, clientEnd, hostEnd } = await resumable();
    clientEnd.end(new CodedCloseError(1006, "dropped"));
    hostEnd.end(new CodedCloseError(1006, "dropped"));
    await flush();
    const closed = nextClose(client);
    const refusal = new SecureLinkError(CloseCode.CryptoFailure, "unknown session kind");
    const reason = new SecureLinkError(CloseCode.IdleTimeout, "could not resume the session", { cause: refusal });
    client.abandon(reason);
    const error = await closed;
    expect(error).toBe(reason);
    expect(error).toMatchObject({ code: CloseCode.IdleTimeout, cause: refusal });
  });
});

describe("a session that has sent more than its ring holds in its life", () => {
  test("still detaches and resumes: records the peer opened before the drop may leave the ring", async () => {
    const { client, server, clientEnd, hostEnd } = await resumable();
    const atClient = collect(client);
    const lifetime = Math.ceil((RECORD_RING_BYTES * 1.1) / CHUNK);
    for (let index = 0; index < lifetime; index += 1) server.send(new Uint8Array(CHUNK));
    await flush();
    expect(total(atClient)).toBe(lifetime * CHUNK);

    clientEnd.end(new CodedCloseError(1006, "dropped"));
    hostEnd.end(new CodedCloseError(1006, "dropped"));
    await flush();
    expect(server.detached).toBe(true);
    // Heartbeat-sized output while the client is away, as an idle terminal sends.
    server.send(new Uint8Array(39));
    server.send(new Uint8Array(39));
    server.send(new Uint8Array(39));
    expect(server.closed).toBe(false);

    const [newClientEnd, newHostEnd] = memoryLinkPair();
    const accepted = serve(server, newHostEnd);
    await client.resume(newClientEnd);
    expect(await accepted).toBe(true);
    await flush();
    expect(total(atClient)).toBe(lifetime * CHUNK + 3 * 39);
    expect(client.detached).toBe(false);
    expect(server.detached).toBe(false);
  });

  test("ends with 4408 once a record sent while detached is pushed out, since the peer can never have it", async () => {
    const { server, clientEnd, hostEnd } = await resumable();
    for (let index = 0; index < Math.ceil((RECORD_RING_BYTES * 1.1) / CHUNK); index += 1) {
      server.send(new Uint8Array(CHUNK));
    }
    await flush();
    clientEnd.end(new CodedCloseError(1006, "dropped"));
    hostEnd.end(new CodedCloseError(1006, "dropped"));
    await flush();
    const closed = nextClose(server);
    for (let index = 0; index <= RECORD_RING_BYTES / CHUNK; index += 1) {
      if (server.closed) break;
      server.send(new Uint8Array(CHUNK));
    }
    expect(await closed).toMatchObject({ code: CloseCode.IdleTimeout });
  });
});
