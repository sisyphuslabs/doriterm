import type { SecureLink } from "@doriface/crypto";
import { describe, expect, test } from "bun:test";
import type { DataHandler } from "../link.ts";
import { type SpeculativeChild, SpeculativeHello, withoutFirstLine } from "./speculative-hello.ts";

const HELLO = new TextEncoder().encode('{"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true}}\n');
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const ANSWER = new TextEncoder().encode('{"jsonrpc":"2.0","id":0,"result":{"framed":true}}\n');

/** An `hc connect` stand-in whose exit the test decides, so a closed child can be kept draining. */
class FakeChild implements SpeculativeChild {
  readonly sent: Uint8Array[] = [];
  readonly exit = Promise.withResolvers<void>();
  readonly exited = this.exit.promise;
  closed = false;
  #handler: DataHandler | undefined;
  readonly #closeHandlers: (() => void)[] = [];

  send(bytes: Uint8Array): Promise<void> {
    this.sent.push(bytes);
    return Promise.resolve();
  }

  onData(handler: DataHandler): void {
    this.#handler = handler;
  }

  onClose(handler: () => void): void {
    this.#closeHandlers.push(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.#closeHandlers.splice(0)) handler();
  }

  emit(bytes: Uint8Array): void {
    void this.#handler?.(bytes);
  }
}

/** A session not yet proven: only `send` is ever called on it. */
function session(): { readonly link: SecureLink; readonly sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  const link = { send: (bytes: Uint8Array) => void sent.push(bytes) } as unknown as SecureLink;
  return { link, sent };
}

function harness(options: { readonly warm?: boolean; readonly answerMs?: number } = {}) {
  const children: FakeChild[] = [];
  let clock = 0;
  const hello = new SpeculativeHello({
    spawn: () => {
      if (options.warm === false) return undefined;
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    answerMs: options.answerMs ?? 60_000,
    now: () => clock,
  });
  return { hello, children, advance: (ms: number) => (clock += ms) };
}

describe("the speculative hello (#1271)", () => {
  test("answers only with hc's hello line, then closes its child; admission finds it answered", async () => {
    const { hello, children } = harness();
    const s = session();
    hello.answer(HELLO, s.link);
    await Promise.resolve();
    const [child] = children;
    expect(child?.sent).toEqual([HELLO]);
    child?.emit(ANSWER.subarray(0, 10));
    expect(s.sent).toEqual([]);
    child?.emit(new Uint8Array([...ANSWER.subarray(10), ...new TextEncoder().encode("more output\n")]));
    expect(s.sent).toEqual([ANSWER]);
    expect(child?.closed).toBe(true);
    expect(hello.settle(s.link)).toBe("answered");
  });

  test("a cold host starts nothing: the hello waits for admission", () => {
    const { hello, children } = harness({ warm: false });
    const s = session();
    hello.answer(HELLO, s.link);
    expect(children).toHaveLength(0);
    expect(hello.settle(s.link)).toBe("not-answered");
  });

  test("a permit is held until the child exits, draining included: a fifth start waits, and a slot frees only on exit", async () => {
    const { hello, children, advance } = harness();
    for (let i = 0; i < 4; i++) hello.answer(HELLO, session().link);
    for (const child of children) child.emit(ANSWER);
    expect(children.every((child) => child.closed)).toBe(true);
    expect(hello.live).toBe(4);
    advance(60_000);
    hello.answer(HELLO, session().link);
    expect(children).toHaveLength(4);
    children[0]?.exit.resolve();
    await children[0]?.exited;
    await Promise.resolve();
    expect(hello.live).toBe(3);
    hello.answer(HELLO, session().link);
    expect(children).toHaveLength(5);
  });

  test("starts are charged at start: at most four in a window however fast children exit", async () => {
    const { hello, children, advance } = harness();
    const startAndExit = async (left: number): Promise<void> => {
      if (left === 0) return;
      hello.answer(HELLO, session().link);
      for (const child of children) child.exit.resolve();
      await Promise.all(children.map((child) => child.exited));
      await Promise.resolve();
      return startAndExit(left - 1);
    };
    await startAndExit(6);
    expect(hello.live).toBe(0);
    expect(children).toHaveLength(4);
    advance(10_000);
    hello.answer(HELLO, session().link);
    expect(children).toHaveLength(5);
  });

  test("an answer that misses its absolute deadline is never sent, and admission's own child answers instead", async () => {
    const { hello, children } = harness({ answerMs: 5 });
    const s = session();
    hello.answer(HELLO, s.link);
    const [child] = children;
    await new Promise<void>((resolve) => child?.onClose(resolve));
    expect(hello.settle(s.link)).toBe("not-answered");
    child?.emit(ANSWER);
    expect(s.sent).toEqual([]);
  });

  test("stop closes every child and waits for each to exit", async () => {
    const { hello, children } = harness();
    hello.answer(HELLO, session().link);
    hello.answer(HELLO, session().link);
    const stopped = hello.stop();
    expect(children.every((child) => child.closed)).toBe(true);
    for (const child of children) child.exit.resolve();
    await stopped;
    await Promise.resolve();
    expect(hello.live).toBe(0);
  });

  test("a child that cannot be started is no failure: nothing is answered early and the hello waits for admission", () => {
    const hello = new SpeculativeHello({
      spawn: () => {
        throw new Error("spawn hc ENOENT");
      },
    });
    const s = session();
    expect(() => hello.answer(HELLO, s.link)).not.toThrow();
    expect(hello.live).toBe(0);
    expect(hello.settle(s.link)).toBe("not-answered");
  });

  test("the admitted link drops exactly hc's first line, split or not, and passes everything after it", async () => {
    const sent: string[] = [];
    const link = withoutFirstLine({
      send: async (bytes) => void sent.push(new TextDecoder().decode(bytes)),
      onData: () => undefined,
      onClose: () => undefined,
      close: () => undefined,
    });
    await link.send(encode('{"id":0,'));
    await link.send(encode('"result":{}}\nframe-1'));
    await link.send(encode("frame-2\n"));
    expect(sent).toEqual(["frame-1", "frame-2\n"]);
  });
});
