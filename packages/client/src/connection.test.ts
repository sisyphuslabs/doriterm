import { describe, expect, test } from "bun:test";
import { HC_METHODS, HcRpcError, parseJsonRpc, type Frame, type JsonRpcNotification } from "@doriface/protocol";
import { HcConnection } from "./connection.ts";
import { HcConnectionClosedError, HcCoreMismatchError, HcHandshakeError } from "./errors.ts";
import { FakeCore } from "./testing/fake-core.ts";
import {
  bytes,
  concatBytes,
  CORE_ID,
  CORE_NAME,
  frame,
  HELLO_REPLY_LINE,
  STATUS_REPLY,
  withId,
} from "./testing/fixtures.ts";

const HEARTBEAT = '{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":7}}';

const next = <T>(register: (resolve: (value: T) => void) => void): Promise<T> =>
  new Promise((resolve) => register(resolve));

async function opened(core: FakeCore): Promise<HcConnection> {
  const connection = HcConnection.open(core.client);
  await core.waitHello();
  core.push(`${HELLO_REPLY_LINE}\n`);
  return connection;
}

describe("HcConnection hello", () => {
  test("sends the exact framed hello hc attach sends", async () => {
    const core = new FakeCore();
    await opened(core);
    expect(core.helloLines).toEqual(['{"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true}}']);
  });

  test("switches to frames at every chunk boundary of the hello reply and the first frame", async () => {
    const stream = concatBytes(bytes(`${HELLO_REPLY_LINE}\n`), frame(0, 0, HEARTBEAT));
    const last = stream.byteLength - 1;
    const openAt = async (split: number) => {
      const core = new FakeCore();
      const opening = HcConnection.open(core.client);
      await core.waitHello();
      core.push(stream.subarray(0, split));
      core.push(stream.subarray(split, last));
      const connection = await opening;
      expect(connection.hello.core).toEqual({ id: CORE_ID, name: CORE_NAME });
      expect(connection.hello.methods).toEqual([...HC_METHODS]);
      const notification = next<JsonRpcNotification>((resolve) => connection.onNotification(resolve));
      core.push(stream.subarray(last));
      expect((await notification).method).toBe("heartbeat");
      connection.close();
    };
    await Promise.all(Array.from({ length: last - 1 }, (_, index) => openAt(index + 1)));
  });

  test("skips banner lines before the hello reply", async () => {
    const core = new FakeCore();
    const opening = HcConnection.open(core.client);
    await core.waitHello();
    core.push(`Welcome to example-host\n\n${HELLO_REPLY_LINE}\n`);
    expect((await opening).hello.version).toBe("0.1.17");
  });

  test("rejects an error reply with HcRpcError and closes the link", async () => {
    const core = new FakeCore();
    const opening = HcConnection.open(core.client);
    const linkClosed = next<Error | undefined>((resolve) => core.client.onClose(resolve));
    await core.waitHello();
    core.push(
      '{"jsonrpc":"2.0","id":0,"error":{"code":-32000,"message":"protocol generation 2 not supported",' +
        '"data":{"kind":"unsupported_generation","hint":"this core speaks generation 1"}}}\n',
    );
    const error: unknown = await opening.catch((caught: unknown) => caught);
    if (!(error instanceof HcRpcError)) throw new Error(`expected HcRpcError, got ${String(error)}`);
    expect([error.kind, error.hint]).toEqual(["unsupported_generation", "this core speaks generation 1"]);
    await linkClosed;
  });

  test("surfaces an hc connect startup error instead of waiting for a reply", async () => {
    const core = new FakeCore();
    const opening = HcConnection.open(core.client);
    await core.waitHello();
    core.push(
      '{"error":{"hint":"use a shorter HC_SESSION (or socket in the config)","kind":"usage",' +
        '"message":"the socket path for session \\"s\\" is too long here"}}\n',
    );
    const error: unknown = await opening.catch((caught: unknown) => caught);
    if (!(error instanceof HcRpcError)) throw new Error(`expected HcRpcError, got ${String(error)}`);
    expect([error.kind, error.hint]).toEqual(["usage", "use a shorter HC_SESSION (or socket in the config)"]);
  });

  test.each([
    ["a newer generation with a changed shape", '{"id":0,"jsonrpc":"2.0","result":{"generation":2}}', "generation 2"],
    ["a core without its id", HELLO_REPLY_LINE.replace(/"core":\{[^}]*\}/, '"core":{}'), "not a HelloResult"],
  ])("rejects %s", async (_name, reply, message) => {
    const core = new FakeCore();
    const opening = HcConnection.open(core.client);
    await core.waitHello();
    core.push(`${reply}\n`);
    await expect(opening).rejects.toThrow(message);
  });

  test.each([
    [
      "a newer protocol generation",
      '{"id":0,"jsonrpc":"2.0","result":{"generation":2}}',
      { kind: "core-newer", generation: 2 },
    ],
    [
      "an older protocol generation",
      '{"id":0,"jsonrpc":"2.0","result":{"generation":0}}',
      { kind: "core-older", generation: 0, need: "0.1.17" },
    ],
    [
      "a core older than the floor",
      HELLO_REPLY_LINE.replace('"version":"0.1.17"', '"version":"0.1.15"'),
      { kind: "core-too-old", version: "0.1.15", need: "0.1.17" },
    ],
  ] as const)("names %s as a core mismatch, which side to update included (#651)", async (_name, reply, mismatch) => {
    const core = new FakeCore();
    const opening = HcConnection.open(core.client);
    await core.waitHello();
    core.push(`${reply}\n`);
    const error: unknown = await opening.catch((caught: unknown) => caught);
    if (!(error instanceof HcCoreMismatchError)) throw new Error(`expected HcCoreMismatchError, got ${String(error)}`);
    expect(error).toBeInstanceOf(HcHandshakeError);
    expect(error.mismatch).toEqual(mismatch);
  });

  test("a core without machine.list, which the workspace calls as it starts, is a mismatch too (#694)", async () => {
    const core = new FakeCore();
    const opening = HcConnection.open(core.client);
    await core.waitHello();
    core.push(`${HELLO_REPLY_LINE.replace('"machine.list",', "")}\n`);
    const error: unknown = await opening.catch((caught: unknown) => caught);
    if (!(error instanceof HcCoreMismatchError)) throw new Error(`expected HcCoreMismatchError, got ${String(error)}`);
    expect(error.mismatch).toEqual({ kind: "core-missing", methods: ["machine.list"], need: "0.1.17" });
  });

  test("names a core build that lacks a method this client calls, which side to update included (#651)", async () => {
    const core = new FakeCore();
    const opening = HcConnection.open(core.client);
    await core.waitHello();
    core.push(`${HELLO_REPLY_LINE.replace('"terminal.keys",', "")}\n`);
    const error: unknown = await opening.catch((caught: unknown) => caught);
    if (!(error instanceof HcCoreMismatchError)) throw new Error(`expected HcCoreMismatchError, got ${String(error)}`);
    expect(error.mismatch).toEqual({ kind: "core-missing", methods: ["terminal.keys"], need: "0.1.17" });
  });

  test("rejects a core that stayed in plain mode", async () => {
    const core = new FakeCore();
    const opening = HcConnection.open(core.client);
    await core.waitHello();
    core.push(`${HELLO_REPLY_LINE.replace('"framed":true', '"framed":false')}\n`);
    await expect(opening).rejects.toThrow(HcHandshakeError);
  });

  test("times out when the core never answers", async () => {
    const core = new FakeCore();
    await expect(HcConnection.open(core.client, { handshakeTimeoutMs: 20 })).rejects.toThrow(HcHandshakeError);
  });
});

describe("HcConnection frames and lifetime", () => {
  test("raw access sees every frame and can send any frame", async () => {
    const core = new FakeCore();
    const connection = await opened(core);
    const seen = next<Frame>((resolve) => connection.raw.onFrame(resolve));
    core.pushFrame(9, 250, "opaque");
    const frameSeen = await seen;
    expect([frameSeen.channel, frameSeen.kind, new TextDecoder().decode(frameSeen.payload)]).toEqual([
      9,
      250,
      "opaque",
    ]);
    connection.raw.send(4, 4, new Uint8Array([1]));
    const sent = await core.waitFrame((f) => f.channel === 4);
    expect([sent.kind, [...sent.payload]]).toEqual([4, [1]]);
  });

  test("delivers no frame after a bad frame closed the connection", async () => {
    const core = new FakeCore();
    const connection = await opened(core);
    const seen: Frame[] = [];
    connection.raw.onFrame((f) => seen.push(f));
    const closed = next<Error | undefined>((resolve) => connection.onClose(resolve));
    core.push(concatBytes(frame(0, 0, "not json"), frame(9, 250, "after")));
    expect(await closed).toBeInstanceOf(Error);
    expect(seen.map((f) => f.channel)).toEqual([0]);
  });

  test("answers a request from the core with unknown_method", async () => {
    const core = new FakeCore();
    await opened(core);
    core.pushFrame(0, 0, '{"jsonrpc":"2.0","id":"c1","method":"peer.ping","params":{}}');
    const reply = await core.waitFrame((f) => f.channel === 0 && new TextDecoder().decode(f.payload).includes("c1"));
    expect(parseJsonRpc(new TextDecoder().decode(reply.payload))).toMatchObject({
      kind: "failure",
      id: "c1",
      error: { code: -32601, data: { kind: "unknown_method" } },
    });
  });

  test("one answered call is one round-trip sample", async () => {
    const core = new FakeCore();
    const connection = await opened(core);
    expect(connection.rtt).toBeUndefined();
    const status = connection.call("server.status");
    const request = await core.waitRequest("server.status");
    core.pushFrame(0, 0, withId(STATUS_REPLY, Number(request.id)));
    await status;
    expect(connection.rtt?.samples).toBe(1);
  });

  test("reports a hang-up as an error and a local close as none", async () => {
    const remote = new FakeCore();
    const dropped = await opened(remote);
    const hangUp = next<Error | undefined>((resolve) => dropped.onClose(resolve));
    remote.hangUp();
    expect(await hangUp).toBeInstanceOf(HcConnectionClosedError);
    expect(dropped.closed).toBe(true);

    const local = await opened(new FakeCore());
    const closed = next<Error | undefined>((resolve) => local.onClose(resolve));
    local.close();
    expect(await closed).toBeUndefined();
    expect(await next<Error | undefined>((resolve) => local.onClose(resolve))).toBeUndefined();
  });
});
