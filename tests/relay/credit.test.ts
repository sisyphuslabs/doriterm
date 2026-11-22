import { CloseCode, encodeAck, encodeCredit, encodeData, MuxType } from "@doriface/relay-client";
import { afterEach, describe, expect, test } from "bun:test";
import { defer, runDeferred } from "./support/cleanup.ts";
import { testIp } from "./support/probe.ts";
import { AsyncQueue } from "./support/queue.ts";
import { type RawHost, startRawHost } from "./support/raw-host.ts";
import { useLocalRelay } from "./support/relay-fixture.ts";

const relay = useLocalRelay();

afterEach(runDeferred);

interface RawClient {
  readonly socket: WebSocket;
  readonly messages: AsyncQueue<string | number>;
  readonly closed: Promise<number>;
}

/** A client socket that records text messages as text and binary ones as their length. */
async function rawClient(hostId: string, ip: string, credit: boolean): Promise<RawClient> {
  const query = credit ? "?credit=1" : "";
  const socket = new WebSocket(`${relay.url.replace("http", "ws")}/v1/client/${hostId}${query}`, {
    headers: { "cf-connecting-ip": ip },
  });
  socket.binaryType = "arraybuffer";
  defer(() => socket.close());
  const messages = new AsyncQueue<string | number>();
  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") messages.push(event.data);
    else if (event.data instanceof ArrayBuffer) messages.push(event.data.byteLength);
  });
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    void closed.then((code) => reject(new Error(`client closed with ${code} before opening`)));
  });
  return { socket, messages, closed };
}

async function opened(host: RawHost): Promise<number> {
  const open = await host.frame();
  if (open.type !== MuxType.Open) throw new Error(`expected OPEN, got ${open.type}`);
  return open.sessionId;
}

describe("end-to-end session credit (v1.4)", () => {
  test("a credit host gets a zero CREDIT after OPEN, and a credit client gets c:0", async () => {
    const ip = testIp();
    const host = await startRawHost(relay.url, ip, { credit: true });
    const client = await rawClient(host.hostId, ip, true);
    const sessionId = await opened(host);
    expect(await host.frame()).toEqual({ type: MuxType.Credit, sessionId, bytes: 0 });
    expect(await client.messages.take()).toBe("c:0");
  });

  test("the host's CREDIT for bytes it received reaches the client as c:<n>", async () => {
    const ip = testIp();
    const host = await startRawHost(relay.url, ip, { credit: true });
    const client = await rawClient(host.hostId, ip, true);
    const sessionId = await opened(host);
    await host.frame();
    expect(await client.messages.take()).toBe("c:0");
    client.socket.send(new Uint8Array(1000));
    expect(await host.frame()).toMatchObject({ type: MuxType.Data, sessionId });
    host.probe.socket.send(encodeCredit(sessionId, 1000));
    expect(await client.messages.take()).toBe("c:1000");
  });

  test("credit split into tiny CREDITs reaches the client as one c:<n>, not one text per frame", async () => {
    const ip = testIp();
    const host = await startRawHost(relay.url, ip, { credit: true });
    const client = await rawClient(host.hostId, ip, true);
    const sessionId = await opened(host);
    await host.frame();
    expect(await client.messages.take()).toBe("c:0");
    client.socket.send(new Uint8Array(1000));
    await host.frame();
    for (const _ of Array.from({ length: 1000 })) host.probe.socket.send(encodeCredit(sessionId, 1));
    host.probe.socket.send(encodeData(sessionId, new Uint8Array(7)));
    expect(await client.messages.take()).toBe("c:1000");
    expect(await client.messages.take()).toBe(7);
  });

  test("a CREDIT for more than the relay forwarded closes the uplink with 4402", async () => {
    const ip = testIp();
    const host = await startRawHost(relay.url, ip, { credit: true });
    const client = await rawClient(host.hostId, ip, true);
    const sessionId = await opened(host);
    await host.frame();
    client.socket.send(new Uint8Array(1000));
    await host.frame();
    host.probe.socket.send(encodeCredit(sessionId, 1001));
    expect((await host.probe.closed).code).toBe(CloseCode.RelayProtocolError);
  });

  test("the client's acks reach a credit host as CREDIT for that session", async () => {
    const ip = testIp();
    const host = await startRawHost(relay.url, ip, { credit: true });
    const client = await rawClient(host.hostId, ip, false);
    const sessionId = await opened(host);
    await host.frame();
    client.socket.send(new Uint8Array(1));
    await host.frame();
    host.probe.socket.send(encodeData(sessionId, new Uint8Array(70_000)));
    expect(await client.messages.take()).toBe(70_000);
    client.socket.send(encodeAck(70_000));
    expect(await host.frame()).toEqual({ type: MuxType.Credit, sessionId, bytes: 70_000 });
  });

  test("an uplink that did not ask for credit never gets CREDIT, nor does its credit client get c:", async () => {
    const ip = testIp();
    const host = await startRawHost(relay.url, ip);
    const client = await rawClient(host.hostId, ip, true);
    const sessionId = await opened(host);
    client.socket.send(new Uint8Array(3));
    expect(await host.frame()).toMatchObject({ type: MuxType.Data, sessionId });
    host.probe.socket.send(encodeData(sessionId, new Uint8Array(5)));
    expect(await client.messages.take()).toBe(5);
    host.probe.socket.send(encodeCredit(sessionId, 3));
    expect((await host.probe.closed).code).toBe(CloseCode.RelayProtocolError);
  });
});
