import { describe, expect, jest, test } from "bun:test";
import { FrameKind, readCredit, type Frame } from "@doriface/protocol";
import { HcConnection, type AttachOptions } from "./connection.ts";
import type { StreamClose } from "./stream-close.ts";
import type { TerminalSize, TerminalStream } from "./terminal-stream.ts";
import { FakeCore, refusingLink } from "./testing/fake-core.ts";
import {
  ATTACH_REPLY,
  concatBytes,
  FIRST_PAINT,
  frame,
  HELLO_REPLY_LINE,
  KILLED_CLOSE,
  OUTPUT_OK,
  withId,
} from "./testing/fixtures.ts";

const CHANNEL = 2;
const PAINT_BYTES = new TextEncoder().encode(FIRST_PAINT).byteLength;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const next = <T>(register: (resolve: (value: T) => void) => void): Promise<T> =>
  new Promise((resolve) => register(resolve));

interface Attached {
  readonly core: FakeCore;
  readonly stream: TerminalStream;
}

async function attached(
  options: AttachOptions = {},
  hello = HELLO_REPLY_LINE,
  reply = ATTACH_REPLY,
): Promise<Attached> {
  const core = new FakeCore();
  const opening = HcConnection.open(core.client);
  await core.waitHello();
  core.push(`${hello}\n`);
  const attaching = (await opening).attach({ terminal: "t1", cols: 100, rows: 30 }, options);
  const request = await core.waitRequest("terminal.attach");
  core.push(concatBytes(frame(0, 0, withId(reply, Number(request.id))), frame(CHANNEL, 0, FIRST_PAINT)));
  return { core, stream: await attaching };
}

const isOnChannel = (kind: number) => (f: Frame) => f.channel === CHANNEL && f.kind === kind;

describe("TerminalStream", () => {
  test("detaching a viewer cancels unreturned credit for its channel", async () => {
    const { core, stream } = await attached();
    jest.useFakeTimers();
    try {
      const paint = await next<Uint8Array>((resolve) => stream.onData(resolve));
      expect(paint.byteLength).toBe(PAINT_BYTES);
      const closing = stream.close();
      await core.waitFrame(isOnChannel(FrameKind.Close));
      jest.advanceTimersByTime(1_000);
      await Promise.resolve();
      expect(core.frames.some(isOnChannel(FrameKind.Credit))).toBe(false);
      core.pushFrame(CHANNEL, FrameKind.Close);
      await closing;
    } finally {
      jest.useRealTimers();
    }
  });

  test("delivers a burst immediately but returns one credit for its small frames", async () => {
    const { core, stream } = await attached();
    const chunks: string[] = [];
    const delivered = Promise.withResolvers<void>();
    stream.onData((chunk) => {
      chunks.push(text(chunk));
      if (chunks.length === 4) delivered.resolve();
    });
    await core.waitFrame(isOnChannel(FrameKind.Credit));
    const start = core.frames.length;
    core.push(concatBytes(frame(CHANNEL, 0, "a"), frame(CHANNEL, 0, "bb"), frame(CHANNEL, 0, "ccc")));
    await delivered.promise;
    expect(chunks.slice(1)).toEqual(["a", "bb", "ccc"]);
    const first = await core.waitFrame(isOnChannel(FrameKind.Credit), start);
    expect(readCredit(first.payload)).toBe(6);
  });

  test("returns a full credit step without waiting for the quiet flush", async () => {
    const { core, stream } = await attached({ autoCredit: false });
    const delivered = Promise.withResolvers<void>();
    const size = 64 * 1024;
    stream.onData((chunk) => {
      if (chunk.byteLength === size) {
        stream.consumed(size);
        stream.focus(true);
        delivered.resolve();
      }
    });
    const start = core.frames.length;
    core.pushFrame(CHANNEL, FrameKind.Data, new Uint8Array(size));
    await delivered.promise;
    await core.waitFrame(isOnChannel(FrameKind.Focus), start);
    const frames = core.frames.slice(start).filter((f) => f.channel === CHANNEL);
    expect(frames.map((f) => f.kind)).toEqual([FrameKind.Credit, FrameKind.Focus]);
    const credit = frames[0];
    if (credit === undefined) throw new Error("no credit returned before focus");
    expect(readCredit(credit.payload)).toBe(size);
  });

  test("holds the first paint that shares a chunk with the attach reply, then credits it", async () => {
    const { core, stream } = await attached();
    expect([stream.channel, stream.terminal.address, stream.size]).toEqual([CHANNEL, "t1", { cols: 100, rows: 30 }]);
    const paint = await next<Uint8Array>((resolve) => stream.onData(resolve));
    expect(paint[0]).toBe(0x18);
    expect(text(paint)).toBe(FIRST_PAINT);
    const credit = await core.waitFrame(isOnChannel(FrameKind.Credit));
    expect(readCredit(credit.payload)).toBe(PAINT_BYTES);
  });

  test("sends input, resize, focus and facts frames as hc 0.1.17 expects them", async () => {
    const { core, stream } = await attached();
    const start = core.frames.length;
    expect(stream.write("echo doriface-ok\r")).toBe(true);
    expect(stream.resize(120, 40)).toBe(true);
    stream.focus(true);
    stream.facts({ fg: "#ffffff", cell: [8, 16] });
    const facts = await core.waitFrame(isOnChannel(FrameKind.Facts), start);
    const sent = core.frames.slice(start).filter((f) => f.channel === CHANNEL);
    expect(sent.map((f) => [f.kind, [...f.payload]])).toEqual([
      [FrameKind.Data, [...new TextEncoder().encode("echo doriface-ok\r")]],
      [FrameKind.Resize, [120, 0, 40, 0]],
      [FrameKind.Focus, [1]],
      [FrameKind.Facts, [...facts.payload]],
    ]);
    expect(JSON.parse(text(facts.payload))).toEqual({ fg: "#ffffff", cell: [8, 16] });
    expect(stream.size).toEqual({ cols: 120, rows: 40 });
    expect(() => stream.resize(0, 40)).toThrow(RangeError);
  });

  test("sends automatic input as DATA unless both hello and attach offer kind 6", async () => {
    const legacy = await attached();
    legacy.stream.writeAutomatic("\x1b[1;1R");
    expect((await legacy.core.waitFrame((f) => f.channel === CHANNEL && f.payload[0] === 0x1b)).kind).toBe(
      FrameKind.Data,
    );
    const modern = await attached(
      {},
      HELLO_REPLY_LINE.replace('"resize_notifications"]', '"resize_notifications","automatic_input"]'),
      ATTACH_REPLY.replace('"channel":2,', '"automatic_input":true,"channel":2,'),
    );
    expect(modern.stream.automaticInput).toBe(true);
    modern.stream.writeAutomatic("\x1b[1;1R");
    expect((await modern.core.waitFrame((f) => f.channel === CHANNEL && f.payload[0] === 0x1b)).kind).toBe(
      FrameKind.AutomaticInput,
    );
  });

  test("with autoCredit off, credits only what the consumer reports", async () => {
    const { core, stream } = await attached({ autoCredit: false });
    const chunks: Uint8Array[] = [];
    const output = next<void>((resolve) =>
      stream.onData((bytes) => {
        chunks.push(bytes);
        if (chunks.length === 2) resolve();
      }),
    );
    core.pushFrame(CHANNEL, FrameKind.Data, OUTPUT_OK);
    await output;
    expect(text(chunks[1] ?? new Uint8Array())).toContain("\r\ndoriface-ok\r\n");
    stream.focus(false);
    await core.waitFrame(isOnChannel(FrameKind.Focus));
    expect(core.frames.some(isOnChannel(FrameKind.Credit))).toBe(false);
    expect(() => stream.consumed(PAINT_BYTES + OUTPUT_OK.length + 1)).toThrow(RangeError);
    stream.consumed(PAINT_BYTES);
    expect(readCredit((await core.waitFrame(isOnChannel(FrameKind.Credit))).payload)).toBe(PAINT_BYTES);
  });

  test("lets an onData listener report consumption of the chunk it is rendering", async () => {
    const { core, stream } = await attached({ autoCredit: false });
    stream.onData((bytes) => stream.consumed(bytes.byteLength));
    expect(readCredit((await core.waitFrame(isOnChannel(FrameKind.Credit))).payload)).toBe(PAINT_BYTES);
  });

  test("applies an observer RESIZE before the data that follows it", async () => {
    const { core, stream } = await attached();
    const seen: string[] = [];
    stream.onResize((size: TerminalSize) => seen.push(`resize ${size.cols}x${size.rows}`));
    const output = next<Uint8Array>((resolve) =>
      stream.onData((bytes) => {
        seen.push(`data ${bytes.byteLength}`);
        if (bytes[0] !== 0x18) resolve(bytes);
      }),
    );
    core.push(concatBytes(frame(CHANNEL, FrameKind.Resize, new Uint8Array([90, 0, 20, 0])), frame(CHANNEL, 0, "x")));
    await output;
    expect(seen).toEqual([`data ${PAINT_BYTES}`, "resize 90x20", "data 1"]);
    expect(stream.size).toEqual({ cols: 90, rows: 20 });
  });

  test("close() detaches and resolves on the core's empty CLOSE", async () => {
    const { core, stream } = await attached();
    const closing = stream.close();
    const sent = await core.waitFrame(isOnChannel(FrameKind.Close));
    expect(sent.payload.byteLength).toBe(0);
    expect(stream.write("late")).toBe(false);
    core.pushFrame(CHANNEL, FrameKind.Close);
    expect(await closing).toEqual({
      by: "viewer",
      reason: "detached",
      exit_code: null,
      signal: null,
      finished_ms: null,
    });
  });

  test("reports the program's end from the CLOSE reason", async () => {
    const { core, stream } = await attached();
    const closed = next<StreamClose>((resolve) => stream.onClose(resolve));
    core.pushFrame(CHANNEL, FrameKind.Close, KILLED_CLOSE);
    expect(await closed).toEqual({
      by: "core",
      reason: "killed",
      exit_code: null,
      signal: 1,
      finished_ms: 1700000003000,
    });
    expect(await next<StreamClose>((resolve) => stream.onClose(resolve))).toMatchObject({ reason: "killed" });
  });

  test("ends with the connection", async () => {
    const { core, stream } = await attached();
    const closed = next<StreamClose>((resolve) => stream.onClose(resolve));
    core.hangUp();
    expect(await closed).toMatchObject({ by: "connection", reason: "connection_closed" });
    expect(stream.state).toBe("closed");
  });

  test("detaching once the socket went away (sends throw, no close yet) does not throw, and the connection ends (#403)", async () => {
    const core = new FakeCore();
    const { link, refuse } = refusingLink(core);
    const opening = HcConnection.open(link);
    await core.waitHello();
    core.push(`${HELLO_REPLY_LINE}\n`);
    const connection = await opening;
    const attaching = connection.attach({ terminal: "t1", cols: 100, rows: 30 });
    const request = await core.waitRequest("terminal.attach");
    core.push(frame(0, 0, withId(ATTACH_REPLY, Number(request.id))));
    const stream = await attaching;
    refuse();
    expect(() => void stream.close()).not.toThrow();
    expect(connection.closed).toBe(true);
  });

  test("input, focus, resize and display facts on a socket that went away are refused with false, never thrown (#403)", async () => {
    const core = new FakeCore();
    const { link, refuse } = refusingLink(core);
    const opening = HcConnection.open(link);
    await core.waitHello();
    core.push(`${HELLO_REPLY_LINE}\n`);
    const connection = await opening;
    const attaching = connection.attach({ terminal: "t1", cols: 100, rows: 30 });
    const request = await core.waitRequest("terminal.attach");
    core.push(frame(0, 0, withId(ATTACH_REPLY, Number(request.id))));
    const stream = await attaching;
    refuse();
    // The first refused write ends the connection; each one after it finds the stream closed.
    expect(stream.focus(false)).toBe(false);
    expect(stream.write("x")).toBe(false);
    expect(stream.resize(80, 24)).toBe(false);
    expect(stream.facts({ fg: "#ffffff" })).toBe(false);
    expect(connection.closed).toBe(true);
  });
});
