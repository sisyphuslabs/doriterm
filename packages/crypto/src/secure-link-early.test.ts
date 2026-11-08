import { describe, expect, test } from "bun:test";
import { CloseCode } from "./link.ts";
import type { SecureLink } from "./secured-link.ts";
import type { MemoryEnd } from "./testing/memory-link.ts";
import { codePairing, collect, connect, flush, settledError } from "./testing/secure-link-fixture.ts";

const HELLO = new TextEncoder().encode('{"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true}}\n');
const ANSWER = new TextEncoder().encode('{"jsonrpc":"2.0","id":0,"result":{"framed":true}}\n');

/** A host hook that answers every early payload with ANSWER and records what it was given. */
function answering() {
  const asked: Uint8Array[] = [];
  const answerEarly = (early: Uint8Array, session: SecureLink): void => {
    asked.push(early);
    session.send(ANSWER);
  };
  return { asked, answerEarly };
}

/** Rewrites the client's second message (its key confirmation), passing message 1 through. */
function onConfirmation(end: MemoryEnd, rewrite: (record: Uint8Array) => readonly Uint8Array[]): void {
  let sent = 0;
  end.tap = (bytes) => {
    sent += 1;
    return sent === 2 ? rewrite(bytes) : [bytes];
  };
}

describe("an early answer before key confirmation (#1271)", () => {
  test("the host's answer reaches the client with message 2, while the client's confirmation is withheld", async () => {
    const { asked, answerEarly } = answering();
    const pair = connect({ early: HELLO, answerEarly, timeoutMs: 300 });
    onConfirmation(pair.clientEnd, () => []);
    const client = await pair.initiator;
    const atClient = collect(client);
    await flush();
    expect(asked).toEqual([HELLO]);
    expect(atClient).toEqual([ANSWER]);
    expect((await settledError(pair.responder)).code).toBe(CloseCode.IdleTimeout);
  });

  test("the session itself still resolves only on the confirmation, and the held early bytes come first", async () => {
    const { answerEarly } = answering();
    const pair = connect({ early: HELLO, answerEarly });
    const [client, server] = await Promise.all([pair.initiator, pair.responder]);
    client.send(Uint8Array.of(1));
    await flush();
    expect(collect(server)).toEqual([HELLO, Uint8Array.of(1)]);
  });

  test("a forged confirmation closes the session 4400 and admits nothing", async () => {
    const { answerEarly } = answering();
    const pair = connect({ early: HELLO, answerEarly });
    onConfirmation(pair.clientEnd, (record) => {
      const forged = record.slice();
      forged[forged.byteLength - 1] = (forged[forged.byteLength - 1] ?? 0) ^ 1;
      return [forged];
    });
    await pair.initiator;
    expect((await settledError(pair.responder)).code).toBe(CloseCode.CryptoFailure);
  });

  test("no early bytes, or a pairing, never asks the hook", async () => {
    const { asked, answerEarly } = answering();
    const plain = connect({ answerEarly });
    await Promise.all([plain.initiator, plain.responder]);
    const paired = connect({ answerEarly, pairing: codePairing("laptop") });
    await Promise.all([paired.initiator, paired.responder]);
    expect(asked).toEqual([]);
  });
});
