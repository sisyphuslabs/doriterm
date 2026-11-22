import { describe, expect, test } from "bun:test";
import { SocketWriter, type WritableSocket } from "./socket-writer.ts";

/** A socket whose send buffer has `room` bytes until the next drain, and records what it took. */
function narrowSocket(room: number): WritableSocket & { readonly taken: number[]; ended: boolean; room: number } {
  const socket = {
    taken: [] as number[],
    ended: false,
    room,
    write(data: Uint8Array): number {
      const n = Math.min(socket.room, data.byteLength);
      socket.room -= n;
      socket.taken.push(...data.subarray(0, n));
      return n;
    },
    end(): void {
      socket.ended = true;
    },
  };
  return socket;
}

const bytes = (from: number, count: number): Uint8Array =>
  Uint8Array.from({ length: count }, (_, i) => (from + i) % 256);

describe("a socket writer", () => {
  test("writes a payload larger than one write whole and in order across drains, and ends only after the last byte", () => {
    const socket = narrowSocket(3);
    const writer = new SocketWriter();
    writer.send(socket, bytes(0, 5));
    writer.send(socket, bytes(5, 4), true);
    expect(socket.taken).toEqual([0, 1, 2]);
    expect(writer.queuedBytes).toBe(6);
    socket.room = 3;
    writer.flush(socket);
    expect(socket.taken).toEqual([0, 1, 2, 3, 4, 5]);
    expect(socket.ended).toBe(false);
    socket.room = 3;
    writer.flush(socket);
    expect(socket.taken).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(writer.queuedBytes).toBe(0);
    expect(socket.ended).toBe(true);
  });

  test("a socket that takes nothing (write returns -1) keeps everything queued for the next drain", () => {
    const socket = { ...narrowSocket(0), write: () => -1 };
    const writer = new SocketWriter();
    writer.send(socket, bytes(0, 4));
    expect(writer.queuedBytes).toBe(4);
  });

  test("nothing is queued after an end was asked for, and clear drops what waits without writing it", () => {
    const socket = narrowSocket(1);
    const writer = new SocketWriter();
    writer.send(socket, bytes(0, 3), true);
    writer.send(socket, bytes(9, 3));
    expect(writer.queuedBytes).toBe(2);
    writer.clear();
    socket.room = 1;
    writer.flush(socket);
    expect(socket.taken).toEqual([0]);
    expect(writer.queuedBytes).toBe(0);
  });
});
