import { describe, expect, test } from "bun:test";
import { ByteQueue } from "../link.ts";
import { type PlaintextSession, plaintextLink, type Wire } from "./links.ts";

/** A decrypted session whose records the test emits by hand. */
function fakeSecure(): PlaintextSession & { readonly emit: (bytes: Uint8Array) => void } {
  let data: ((bytes: Uint8Array) => void) | undefined;
  return {
    link: undefined,
    send() {},
    onData(listener) {
      data = listener;
      return () => {};
    },
    onClose: () => () => {},
    onLink: () => () => {},
    attached: () => Promise.resolve(),
    close() {},
    emit: (bytes) => data?.(bytes),
  };
}

const OPEN_GATE = (): Promise<void> | undefined => undefined;

describe("plaintextLink", () => {
  test("the socket reads no further record while hc connect is behind, and resumes once it caught up", async () => {
    const secure = fakeSecure();
    let gate = OPEN_GATE;
    const wire: Wire = { flushed: () => Promise.resolve(), readWhen: (next) => (gate = next) };
    const link = plaintextLink(secure, wire);
    const decrypted: number[] = [];
    // The socket side, as WsByteLink wires it: each record is decrypted, then the next waits for the gate.
    const errors: unknown[] = [];
    const socket = new ByteQueue({ onError: (error) => errors.push(error) });
    socket.setHandler((record) => {
      decrypted.push(record[0] ?? -1);
      secure.emit(record);
      return gate();
    });
    const slow = Promise.withResolvers<void>();
    const delivered: number[] = [];
    link.onData((bytes) => {
      delivered.push(bytes[0] ?? -1);
      return bytes[0] === 1 ? slow.promise : undefined;
    });
    for (const record of [1, 2, 3]) socket.push(Uint8Array.of(record));
    await new Promise((resolve) => setImmediate(resolve));
    expect(decrypted).toEqual([1, 2]);
    slow.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(decrypted).toEqual([1, 2, 3]);
    expect(delivered).toEqual([1, 2, 3]);
    expect(errors).toEqual([]);
  });
});
