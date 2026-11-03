import { CloseCode } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { describe, expect, test } from "bun:test";
import { type LineLink, MAX_LINE_BYTES, MAX_QUEUED_BYTES, MeshLines, SYNC_EXPECTS } from "./lines.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function pair() {
  const [sender, receiver] = memoryLinkPair();
  return { sender, receiver, lines: new MeshLines(receiver, ["done", "refused"]) };
}

describe("the sync lines (section 5.2)", () => {
  test("hello and want are read with their members", async () => {
    const [sender, receiver] = memoryLinkPair();
    const lines = new MeshLines(receiver, SYNC_EXPECTS);
    const [h1, h0, key] = ["A".repeat(43), "E".repeat(43), "I".repeat(43)];
    const n = { [key]: 3 };
    sender.send(encode(`${JSON.stringify({ t: "hello", v: 2, mesh: "m", heads: [h1], n })}\n`));
    sender.send(encode(`${JSON.stringify({ t: "want", hashes: [h0] })}\n`));
    expect(await lines.next()).toEqual({ t: "hello", v: 2, mesh: "m", heads: [h1], n });
    expect(await lines.next()).toEqual({ t: "want", hashes: [h0] });
  });

  test.each([
    ["a hello of another version", '{"t":"hello","v":1,"mesh":"m","heads":[],"n":{}}\n'],
    ["a hello without counters", '{"t":"hello","v":2,"mesh":"m","heads":[]}\n'],
    ["a hello with a fractional counter", '{"t":"hello","v":2,"mesh":"m","heads":[],"n":{"k":1.5}}\n'],
    ["a want of numbers", '{"t":"want","hashes":[1]}\n'],
  ])("%s closes the session with 4400", async (_, text) => {
    const [sender, receiver] = memoryLinkPair();
    const read = new MeshLines(receiver, SYNC_EXPECTS).next().then(
      () => "read",
      () => "closed",
    );
    sender.send(encode(text));
    expect(await read).toBe("closed");
    expect(receiver.closeCode).toBe(CloseCode.CryptoFailure);
  });
});

describe("mesh stream lines (section 10.2)", () => {
  test("lines split across chunks are read whole, and an unknown type is skipped", async () => {
    const { sender, lines } = pair();
    sender.send(encode('{"t":"future","x":1}\n{"t":"done",'));
    sender.send(encode('"mesh":"m"}\n'));
    expect(await lines.next()).toEqual({ t: "done", mesh: "m" });
  });

  test.each([
    ["not JSON", "nope\n"],
    ["a known type with a bad shape", '{"t":"records","records":[{"body":1}]}\n'],
    ["a line over 256 KiB", `{"t":"refused","reason":"${"x".repeat(MAX_LINE_BYTES)}"}\n`],
  ])("%s closes the session with 4400", async (_, text) => {
    const { sender, receiver, lines } = pair();
    const read = lines.next().then(
      () => "read",
      () => "closed",
    );
    sender.send(encode(text));
    expect(await read).toBe("closed");
    expect(receiver.closeCode).toBe(CloseCode.CryptoFailure);
  });

  test("lines nobody reads close the session with 4400 once they pass 4 MiB, before the line bound", async () => {
    const { sender, receiver, lines } = pair();
    const big = `{"t":"done","mesh":"${"x".repeat(200 * 1024)}"}\n`;
    for (let i = 0; i < 30; i++) sender.send(encode(big));
    await new Promise((resolve) => setImmediate(resolve));
    expect(receiver.closeCode).toBe(CloseCode.CryptoFailure);
    const held = await drain(lines);
    expect(held * 200 * 1024).toBeLessThanOrEqual(MAX_QUEUED_BYTES);
  });

  test("256 KiB without a line feed closes the session with 4400", async () => {
    const { sender, receiver } = pair();
    sender.send(encode(`{"t":"done","mesh":"${"x".repeat(MAX_LINE_BYTES)}`));
    await new Promise((resolve) => setImmediate(resolve));
    expect(receiver.closeCode).toBe(CloseCode.CryptoFailure);
  });

  test("a stray line that closes the session takes the lines queued before it along", async () => {
    const { sender, receiver, lines } = pair();
    sender.send(encode('{"t":"done","mesh":"m"}\n{"t":"card","body":"b","sig":"s"}\n'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(receiver.closeCode).toBe(CloseCode.CryptoFailure);
    expect(
      await lines.next().then(
        () => "read",
        (error: unknown) => String(error),
      ),
    ).toContain("unexpected card line");
  });

  test("detach stops listening to the session", () => {
    const data = new Set<(bytes: Uint8Array) => void>();
    const closes = new Set<(error: Error | undefined) => void>();
    const link: LineLink = {
      send: () => {},
      onData: (listener) => {
        data.add(listener);
        return () => void data.delete(listener);
      },
      onClose: (listener) => {
        closes.add(listener);
        return () => void closes.delete(listener);
      },
      close: () => {},
    };
    const lines = new MeshLines(link, ["done"]);
    expect([data.size, closes.size]).toEqual([1, 1]);
    lines.detach();
    expect([data.size, closes.size]).toEqual([0, 0]);
  });
});

const drain = (lines: MeshLines, count = 0): Promise<number> =>
  lines.next().then(
    () => drain(lines, count + 1),
    () => count,
  );
