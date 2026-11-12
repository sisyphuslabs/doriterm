import { describe, expect, test } from "bun:test";
import { type ByteLink, CloseCode, closeCodeOf } from "./link.ts";
import { RECORD_RING_BYTES } from "./record-ring.ts";
import { decodeResumeRequest, encodeResumeAnswer, encodeResumeRequest } from "./resume.ts";
import type { SecureSession } from "./secured-link.ts";
import { CodedCloseError, type MemoryEnd, memoryLinkPair, nextClose } from "./testing/memory-link.ts";
import { collect, established, flush, type Setup, tamperNext } from "./testing/secure-link-fixture.ts";

const dropped = (): CodedCloseError => new CodedCloseError(1006, "dropped");

/** Both ends of a session lose their socket at once, as a relay blip does. */
function drop(clientEnd: MemoryEnd, hostEnd: MemoryEnd): void {
  clientEnd.end(dropped());
  hostEnd.end(dropped());
}

/** The host side of a resume: the first message on a fresh link is handed to the session, as the gateway does. */
function serve(server: SecureSession, hostEnd: ByteLink): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const unsubscribe = hostEnd.onData((first) => {
    unsubscribe();
    resolve(server.accept(hostEnd, first));
  });
  return promise;
}

async function resumable(setup: Setup = {}) {
  const session = await established(setup);
  session.client.allowResume();
  session.server.allowResume();
  return session;
}

const texts = (chunks: readonly Uint8Array[]): string[] => chunks.map((chunk) => new TextDecoder().decode(chunk));
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("a session whose link drops", () => {
  test("detaches when a resume is allowed, closes when it is not, and ends on a normal close either way", async () => {
    const plain = await established();
    const plainClosed = nextClose(plain.client);
    plain.clientEnd.end(dropped());
    expect(await plainClosed).toBeInstanceOf(Error);

    const { client, server, clientEnd, hostEnd } = await resumable();
    const detachedFor: Error[] = [];
    client.onDetached((reason) => detachedFor.push(reason));
    drop(clientEnd, hostEnd);
    await flush();
    expect(client.detached).toBe(true);
    expect(server.detached).toBe(true);
    expect(client.closed).toBe(false);
    expect(client.link).toBeUndefined();
    expect(detachedFor.map((error) => error.message)).toEqual(["dropped"]);

    const polite = await resumable();
    const closed = nextClose(polite.client);
    polite.hostEnd.close();
    expect(await closed).toBeUndefined();
    expect(polite.client.closed).toBe(true);
  });

  test("ends on a close the peer meant, going away (1001), as a host shutting down sends: no detach, no resume", async () => {
    const { client, server, clientEnd } = await resumable();
    const detachedFor: Error[] = [];
    client.onDetached((reason) => detachedFor.push(reason));
    const closed = nextClose(client);
    clientEnd.end(new CodedCloseError(1001, "host shutting down"));
    const error = await closed;
    expect(error).toBeInstanceOf(Error);
    expect(closeCodeOf(error)).toBe(1001);
    expect(client.closed).toBe(true);
    expect(client.detached).toBe(false);
    expect(detachedFor).toEqual([]);
    expect(server.closed).toBe(false);
  });

  test("lost() detaches an open session and closes its link once; the link's own close report is then a former one's", async () => {
    const { client, clientEnd } = await resumable();
    expect(client.lost(new Error("silent"))).toBe(true);
    expect(client.detached).toBe(true);
    expect(clientEnd.closeCode).toBe(CloseCode.IdleTimeout);
    expect(client.lost(new Error("again"))).toBe(true);
    await flush();
    expect(client.closed).toBe(false);
    const plain = await established();
    expect(plain.client.lost(new Error("silent"))).toBe(false);
    expect(plain.client.closed).toBe(false);
  });
});

describe("an idle resume", () => {
  test("carries one request and one answer and nothing else, and the session's listeners stay", async () => {
    const { client, server, clientEnd, hostEnd } = await resumable();
    const atServer = collect(server);
    const atClient = collect(client);
    drop(clientEnd, hostEnd);
    await flush();
    const [newClientEnd, newHostEnd] = memoryLinkPair();
    const accepted = serve(server, newHostEnd);
    await client.resume(newClientEnd);
    expect(await accepted).toBe(true);
    expect(newClientEnd.sent.length).toBe(1);
    expect(newHostEnd.sent.length).toBe(1);
    expect(client.link).toBe(newClientEnd);
    expect(server.link).toBe(newHostEnd);
    client.send(bytes("after"));
    server.send(bytes("back"));
    await flush();
    expect(texts(atServer)).toEqual(["after"]);
    expect(texts(atClient)).toEqual(["back"]);
    expect(newClientEnd.sent.length).toBe(2);
    expect(newHostEnd.sent.length).toBe(2);
  });

  test("attached() waits for the new link, and the former link's late close means nothing", async () => {
    const { client, server, clientEnd, hostEnd } = await resumable();
    expect(await Promise.race([client.attached().then(() => "now"), flush().then(() => "later")])).toBe("now");
    clientEnd.end(dropped());
    hostEnd.end(dropped());
    await flush();
    let attached = false;
    void client.attached().then(() => {
      attached = true;
      return undefined;
    });
    await flush();
    expect(attached).toBe(false);
    const [newClientEnd, newHostEnd] = memoryLinkPair();
    const accepted = serve(server, newHostEnd);
    await client.resume(newClientEnd);
    expect(await accepted).toBe(true);
    await flush();
    expect(attached).toBe(true);
    clientEnd.close(1006, "late");
    hostEnd.close(1006, "late");
    await flush();
    expect(client.closed).toBe(false);
    expect(client.detached).toBe(false);
  });
});

describe("a resume with missed records", () => {
  test("sends the peer exactly the records it never opened, in order, then what was sent while detached", async () => {
    const { client, server, clientEnd, hostEnd } = await resumable();
    const atClient = collect(client);
    const atServer = collect(server);
    server.send(bytes("one"));
    await flush();
    // "two" is lost in flight: the socket died under it.
    tamperNext(hostEnd, () => []);
    server.send(bytes("two"));
    await flush();
    drop(clientEnd, hostEnd);
    await flush();
    server.send(bytes("three"));
    client.send(bytes("typed"));
    // The client's first record is its key confirmation; the host's three are the texts.
    expect(server.counters).toEqual({ sent: 3, received: 1 });
    expect(client.counters).toEqual({ sent: 2, received: 1 });
    const [newClientEnd, newHostEnd] = memoryLinkPair();
    const accepted = serve(server, newHostEnd);
    await client.resume(newClientEnd);
    expect(await accepted).toBe(true);
    await flush();
    expect(texts(atClient)).toEqual(["one", "two", "three"]);
    expect(texts(atServer)).toEqual(["typed"]);
    // The answer, then the two records the client missed.
    expect(newHostEnd.sent.length).toBe(3);
    // The request, then the record typed while detached.
    expect(newClientEnd.sent.length).toBe(2);
  });

  test("counts the host's early answer (#1271), so a resume after it joins", async () => {
    const early = bytes("hello\n");
    const { client, server, clientEnd, hostEnd } = await resumable({
      early,
      answerEarly: (_early, session) => session.send(bytes("welcome\n")),
    });
    const atClient = collect(client);
    await flush();
    expect(texts(atClient)).toEqual(["welcome\n"]);
    expect(client.counters.received).toBe(server.counters.sent);
    drop(clientEnd, hostEnd);
    await flush();
    server.send(bytes("more"));
    const [newClientEnd, newHostEnd] = memoryLinkPair();
    const accepted = serve(server, newHostEnd);
    await client.resume(newClientEnd);
    expect(await accepted).toBe(true);
    await flush();
    expect(texts(atClient)).toEqual(["welcome\n", "more"]);
  });
});

describe("a resume the host cannot honour", () => {
  test("is refused for another session's keys and for a position the ring no longer holds; the session stays as it was", async () => {
    const { server, clientEnd, hostEnd } = await resumable();
    const other = await resumable();
    drop(clientEnd, hostEnd);
    await flush();
    const [, newHostEnd] = memoryLinkPair();
    expect(server.accept(newHostEnd, encodeResumeRequest(other.client.resumeKeys, other.client.counters))).toBe(false);
    expect(server.accept(newHostEnd, bytes("not a request"))).toBe(false);
    // More than the ring holds went out while attached: the oldest records are gone.
    const big = await resumable();
    big.server.send(new Uint8Array(RECORD_RING_BYTES));
    big.server.send(new Uint8Array(1024));
    await flush();
    drop(big.clientEnd, big.hostEnd);
    await flush();
    const behind = encodeResumeRequest(big.server.resumeKeys, { sent: big.client.counters.sent, received: 0 });
    expect(big.server.accept(newHostEnd, behind)).toBe(false);
    expect(big.server.detached).toBe(true);
    expect(server.detached).toBe(true);
    expect(newHostEnd.sent.length).toBe(0);
  });

  test("a link that never answers fails the resume with 4408 and leaves the session detached for another try", async () => {
    const { client, clientEnd, hostEnd } = await resumable();
    drop(clientEnd, hostEnd);
    await flush();
    const [newClientEnd] = memoryLinkPair();
    const failed = await client.resume(newClientEnd, 20).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toMatchObject({ code: CloseCode.IdleTimeout });
    expect(newClientEnd.closeCode).toBe(CloseCode.IdleTimeout);
    expect(client.detached).toBe(true);
    expect(client.closed).toBe(false);
  });

  test("an answer that is no answer fails with 4400; one from a position that cannot be joined with 4413", async () => {
    const { client, server, clientEnd, hostEnd } = await resumable();
    drop(clientEnd, hostEnd);
    await flush();
    const outcome = async (answer: (request: Uint8Array) => Uint8Array): Promise<unknown> => {
      const [newClientEnd, newHostEnd] = memoryLinkPair();
      newHostEnd.onData((request) => newHostEnd.send(answer(request)));
      return client.resume(newClientEnd).then(
        () => undefined,
        (error: unknown) => error,
      );
    };
    expect(await outcome(() => bytes("not an answer"))).toMatchObject({ code: CloseCode.CryptoFailure });
    expect(client.detached).toBe(true);
    // A genuine answer claiming the client opened more than the host ever sent: no position joins it.
    const ahead = await outcome((request) => {
      const theirs = decodeResumeRequest(server.resumeKeys, request);
      if (theirs === undefined) throw new Error("the client sent no request");
      return encodeResumeAnswer(server.resumeKeys, theirs, { sent: 0, received: theirs.sent + 5 });
    });
    expect(ahead).toMatchObject({ code: CloseCode.ResumeRefused });
    expect(client.detached).toBe(true);
    expect(client.closed).toBe(false);
  });

  test("more than the ring holds sent while detached fails the session with 4408", async () => {
    const { server, clientEnd, hostEnd } = await resumable();
    drop(clientEnd, hostEnd);
    await flush();
    const closed = nextClose(server);
    // One write larger than the ring: its first records are pushed out before the peer could ever get them.
    server.send(new Uint8Array(RECORD_RING_BYTES + 1024));
    expect(await closed).toMatchObject({ code: CloseCode.IdleTimeout });
    expect(server.closed).toBe(true);
    expect(() => server.send(bytes("more"))).toThrow();
  });
});
