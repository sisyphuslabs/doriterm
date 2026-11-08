import { describe, expect, spyOn, test } from "bun:test";
import { encodeFrame, type Frame, FrameDecoder, FrameKind, RPC_CHANNEL } from "@doriface/protocol";
import { attachAfterRun } from "./attach-after-run.ts";
import type { DataHandler, Link } from "./link.ts";
import { HELLO } from "./testing/hc-session.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HELLO_REPLY = encoder.encode('{"jsonrpc":"2.0","id":0,"result":{"framed":true}}\n');
const NAME = "opened-0a1b2c3d4e5f";

/** A core that keeps every byte it is sent, and sends what it is told to. */
class FakeCore implements Link {
  readonly sent: Uint8Array[] = [];
  #handler: DataHandler | undefined;

  send(bytes: Uint8Array): Promise<void> {
    this.sent.push(bytes.slice());
    return Promise.resolve();
  }

  onData(handler: DataHandler): void {
    this.#handler = handler;
  }

  onClose(): void {}

  close(): void {}

  async reply(bytes: Uint8Array): Promise<void> {
    await this.#handler?.(bytes);
  }

  get sentBytes(): number {
    return this.sent.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  }

  /** The frames sent after the hello line, decoded as hc reads them. */
  frames(): Frame[] {
    const all = new Uint8Array(this.sentBytes);
    let at = 0;
    for (const chunk of this.sent) {
      all.set(chunk, at);
      at += chunk.byteLength;
    }
    return new FrameDecoder().push(all.subarray(HELLO.byteLength));
  }
}

const rpc = (id: number, method: string, params: object): Uint8Array =>
  encodeFrame(RPC_CHANNEL, FrameKind.Data, encoder.encode(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
const RUN = rpc(1, "terminal.run", { name: NAME, argv: ["sh"] });
const ATTACH = rpc(2, "terminal.attach", { terminal: NAME, cols: 80, rows: 24 });
const RUN_REPLY = encodeFrame(
  RPC_CHANNEL,
  FrameKind.Data,
  encoder.encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { address: "t1", name: NAME } })),
);

/** A link past the framed hello, with a run sent and the attach behind it held for the run's answer. */
async function heldAttach(): Promise<{ readonly core: FakeCore; readonly link: Link }> {
  const core = new FakeCore();
  const link = attachAfterRun(core);
  link.onData(() => undefined);
  await link.send(HELLO);
  await core.reply(HELLO_REPLY);
  await link.send(new Uint8Array([...RUN, ...ATTACH]));
  return { core, link };
}

const methodOf = (frame: Frame): string =>
  frame.channel === RPC_CHANNEL ? String(JSON.parse(decoder.decode(frame.payload)).method) : `channel ${frame.channel}`;

describe("an attach held for its run goes to the core between frames, never inside one", () => {
  const cases = [
    ["a stream frame passed on as it comes", encodeFrame(7, FrameKind.Data, new Uint8Array(100)), "channel 7"],
    [
      "a request frame read whole first",
      rpc(3, "terminal.keys", { terminal: "t9", text: "a".repeat(100) }),
      "terminal.keys",
    ],
  ] as const;
  for (const [what, frame, middle] of cases) {
    for (const cut of [4, 50]) {
      test(`${what}, cut ${cut} bytes in, when the run's answer lands`, async () => {
        const { core, link } = await heldAttach();
        await link.send(frame.subarray(0, cut));
        await core.reply(RUN_REPLY);
        await link.send(frame.subarray(cut));
        expect(core.frames().map(methodOf)).toEqual(["terminal.run", middle, "terminal.attach"]);
      });
    }
  }

  test("on a frame boundary, the run's answer sends the attach at once", async () => {
    const { core } = await heldAttach();
    expect(core.frames().map(methodOf)).toEqual(["terminal.run"]);
    await core.reply(RUN_REPLY);
    expect(core.frames().map(methodOf)).toEqual(["terminal.run", "terminal.attach"]);
  });
});

describe("a frame hc would not read", () => {
  test("a header longer than any frame is passed on with what follows, not buffered, so hc fails the stream", async () => {
    const core = new FakeCore();
    const link = attachAfterRun(core);
    link.onData(() => undefined);
    await link.send(HELLO);
    await core.reply(HELLO_REPLY);
    const header = new Uint8Array(9);
    new DataView(header.buffer).setUint32(5, 0xfffffff0, true);
    const before = core.sentBytes;
    await link.send(header);
    await link.send(new Uint8Array(1024 * 1024));
    expect(core.sentBytes - before).toBe(header.byteLength + 1024 * 1024);
  });
});

describe("a request frame in many records", () => {
  test("is joined once: the bytes copied grow with the frame, not with frame size times records (#481)", async () => {
    const { core, link } = await heldAttach();
    const frame = rpc(3, "terminal.keys", { terminal: "t9", text: "a".repeat(1024 * 1024) });
    const records = 1024;
    const step = Math.ceil(frame.byteLength / records);
    const copies = spyOn(Uint8Array.prototype, "set");
    let copied = 0;
    try {
      for (let at = 0; at < frame.byteLength; at += step) {
        // oxlint-disable-next-line no-await-in-loop -- records arrive one after another
        await link.send(frame.subarray(at, at + step));
      }
      copied = copies.mock.calls.reduce((sum, [source]) => sum + source.length, 0);
    } finally {
      copies.mockRestore();
    }
    expect(copied).toBeLessThanOrEqual(2 * frame.byteLength);
    expect(core.frames().map(methodOf)).toEqual(["terminal.run", "terminal.keys"]);
  });
});
