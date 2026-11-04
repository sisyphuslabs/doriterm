import { describe, expect, test } from "bun:test";
import { CloseFrameReader } from "./close-frames.ts";

const head = Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n", "latin1");

function frame(opcode: number, payload: Uint8Array): Uint8Array {
  const short = payload.length < 126 ? payload.length : payload.length < 65_536 ? 126 : 127;
  const extra = short === 126 ? 2 : short === 127 ? 8 : 0;
  const out = new Uint8Array(2 + extra + payload.length);
  const view = new DataView(out.buffer);
  out[0] = 0x80 | opcode;
  out[1] = short;
  if (short === 126) view.setUint16(2, payload.length);
  if (short === 127) view.setBigUint64(2, BigInt(payload.length));
  out.set(payload, 2 + extra);
  return out;
}

const close = (code: number): Uint8Array => {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint16(0, code);
  return frame(0x8, payload);
};

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("the tap's close-frame reader", () => {
  test("finds the close code after the head and any data frames, in one chunk or split byte by byte", () => {
    const stream = concat(
      head,
      frame(0x2, new Uint8Array(70_000).fill(8)),
      frame(0x2, new Uint8Array(200)),
      close(4429),
    );
    const whole = new CloseFrameReader();
    whole.feed(stream);
    const split = new CloseFrameReader();
    for (const byte of stream) split.feed(new Uint8Array([byte]));
    expect([whole.codes, split.codes]).toEqual([[4429], [4429]]);
  });

  test("a stream with no close frame reports no code", () => {
    const reader = new CloseFrameReader();
    reader.feed(concat(head, frame(0x1, new Uint8Array(10))));
    expect(reader.codes).toEqual([]);
  });
});
