import { afterAll, beforeAll, expect, test } from "bun:test";
import { encodeFrame, FrameKind, RPC_CHANNEL } from "@doriface/protocol";
import { attachAfterRun } from "./attach-after-run.ts";
import { HcPipe } from "./hc-pipe.ts";
import { ByteReader } from "./testing/byte-reader.ts";
import { createHcSession, HELLO, type HcSession } from "./testing/hc-session.ts";

let hc: HcSession;
beforeAll(() => {
  hc = createHcSession("attach-after-run");
});
afterAll(async () => {
  await hc.dispose();
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const request = (id: number, method: string, params: object): Uint8Array =>
  encodeFrame(RPC_CHANNEL, FrameKind.Data, encoder.encode(JSON.stringify({ jsonrpc: "2.0", id, method, params })));

interface Reply {
  readonly id: number;
  readonly result?: { readonly address?: string; readonly channel?: number; readonly terminal?: { address: string } };
  readonly error?: { readonly data?: { readonly kind?: string } };
}

/** Reads frames until the replies to `ids` are in; stream output on other channels is skipped. */
async function replies(reader: ByteReader, ids: readonly number[]): Promise<Map<number, Reply>> {
  const found = new Map<number, Reply>();
  while (found.size < ids.length) {
    // oxlint-disable-next-line no-await-in-loop -- frames are read one after another
    const frame = await reader.frame();
    const view = new DataView(frame.buffer, frame.byteOffset);
    if (view.getUint32(0, true) !== RPC_CHANNEL) continue;
    const message: Reply = JSON.parse(decoder.decode(frame.subarray(9)));
    if (ids.includes(message.id)) found.set(message.id, message);
  }
  return found;
}

test("an attach sent right behind the run that names its terminal attaches to that terminal (#1351)", async () => {
  const core = attachAfterRun(new HcPipe({ hc: hc.hc, session: hc.name, env: hc.env, log: () => {} }));
  const reader = new ByteReader();
  core.onData((bytes) => reader.push(bytes));
  try {
    await core.send(HELLO);
    await reader.line();
    const name = `opened-${crypto.randomUUID().slice(0, 8)}`;
    // One write, as one relay message: the run, and the attach by the name the run gives the terminal.
    const both = new Uint8Array([
      ...request(1, "terminal.run", { name, argv: ["sh", "-c", "echo ready; sleep 30"] }),
      ...request(2, "terminal.attach", { terminal: name, cols: 80, rows: 24 }),
    ]);
    await core.send(both);
    const answered = await replies(reader, [1, 2]);
    const run = answered.get(1);
    const attach = answered.get(2);
    expect(run?.error).toBeUndefined();
    expect(attach?.error).toBeUndefined();
    expect(attach?.result?.terminal?.address).toBe(run?.result?.address);
    expect(typeof attach?.result?.channel).toBe("number");
  } finally {
    core.close();
  }
});
