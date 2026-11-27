import { CloseCode, encodeResumeRequest, resumeKeys } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { afterEach, describe, expect, test } from "bun:test";
import type { E2eeTransport } from "./accept.ts";
import {
  bytes,
  cleanupResumeHosts,
  dropped,
  flush,
  resumeHost as host,
  texts,
  wireOf,
} from "../testing/resume-harness.ts";

afterEach(cleanupResumeHosts);

/** The transports a session can run on; a resume is the same exchange on each (the loopback socket carries no session). */
const TRANSPORTS: readonly E2eeTransport[] = [{ kind: "relay" }, { kind: "lan" }];

describe("an hc session whose link drops", () => {
  test.each(TRANSPORTS)(
    "over %p keeps its hc connect, and the client's resume carries on with what was typed meanwhile, exactly once",
    async (transport) => {
      const h = host();
      const { client, clientEnd, hostEnd, received } = await h.connect(transport);
      client.send(bytes("one\n"));
      await flush();
      expect(texts(received)).toEqual(["one\n"]);
      clientEnd.end(dropped());
      hostEnd.end(dropped());
      await flush();
      expect(h.children.length).toBe(1);
      expect(h.children[0]?.state.closed).toBe(false);
      expect(client.detached).toBe(true);
      client.send(bytes("two\n"));
      const again = h.redial(transport);
      await client.resume(again.clientEnd);
      await again.served;
      client.send(bytes("three\n"));
      await flush();
      expect(texts(received)).toEqual(["one\n", "two\n", "three\n"]);
      expect(h.children.length).toBe(1);
      expect(h.logs.some((line) => line.startsWith("session detached"))).toBe(true);
      expect(h.logs).toContain("session resumed on a new link");
    },
  );

  test("ends, hc connect with it, once the resume window passed; a resume after that is refused with 4413", async () => {
    const h = host(40);
    const { client, clientEnd, hostEnd } = await h.connect();
    clientEnd.end(dropped());
    hostEnd.end(dropped());
    await flush();
    expect(h.children[0]?.state.closed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(h.children[0]?.state.closed).toBe(true);
    const again = h.redial();
    const failed = await client.resume(again.clientEnd).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(Error);
    await again.served;
    expect(again.hostEnd.closeCode).toBe(CloseCode.ResumeRefused);
    expect(h.children.length).toBe(1);
  });

  test("a normal close ends the session at once, and the former link's late close after a resume means nothing", async () => {
    const h = host();
    const polite = await h.connect();
    polite.clientEnd.close();
    await flush();
    expect(h.children[0]?.state.closed).toBe(true);

    const { client, clientEnd, hostEnd, received } = await h.connect();
    // The client's socket died under it, but the host's side of the old link is still open (half-open).
    clientEnd.end(dropped());
    await flush();
    const again = h.redial();
    await client.resume(again.clientEnd);
    await again.served;
    await flush();
    expect(hostEnd.closeCode).toBe(1000);
    client.send(bytes("after\n"));
    await flush();
    expect(texts(received)).toEqual(["after\n"]);
    expect(h.children.length).toBe(2);
    expect(h.children[1]?.state.closed).toBe(false);
  });
});

describe("a host that stops", () => {
  test("ends a session waiting for its client at once, hc connect with it", async () => {
    const h = host();
    const { clientEnd, hostEnd } = await h.connect();
    clientEnd.end(dropped());
    hostEnd.end(dropped());
    await flush();
    expect(h.children[0]?.state.closed).toBe(false);
    await h.gateway.closeAll();
    expect(h.children[0]?.state.closed).toBe(true);
  });
});

describe("a resume request the host cannot honour", () => {
  test("for a session it does not hold is refused with 4413, and starts no hc connect", async () => {
    const h = host();
    const stranger = resumeKeys(new Uint8Array(32).fill(7));
    const [clientEnd, hostEnd] = memoryLinkPair();
    const served = h.gateway.serveE2ee(wireOf(hostEnd), { kind: "relay" });
    clientEnd.send(encodeResumeRequest(stranger, { sent: 1, received: 0 }));
    await served;
    await flush();
    expect(clientEnd.closeCode === undefined ? hostEnd.closeCode : clientEnd.closeCode).toBe(CloseCode.ResumeRefused);
    expect(h.children.length).toBe(0);
    expect(h.logs).toContain("resume refused: no such session");
  });
});
