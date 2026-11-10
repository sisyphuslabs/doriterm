import { describe, expect, test } from "bun:test";
import type { Link } from "../link.ts";
import { helloOnly } from "./pairing-session.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const ANSWER = encode('{"jsonrpc":"2.0","id":0,"result":{"framed":true}}\n');

function harness() {
  const sent: Uint8Array[] = [];
  const inner: Link = {
    send: (bytes) => {
      sent.push(bytes);
      return Promise.resolve();
    },
    onData: () => undefined,
    onClose: () => undefined,
    close: () => undefined,
  };
  let closes = 0;
  const link = helloOnly(inner, () => (closes += 1));
  return { link, sent, closes: () => closes };
}

describe("a pairing session's link on a host at its session limit (#1271, #1291)", () => {
  test("closes once hc's hello answer has gone out, and only once", async () => {
    const { link, sent, closes } = harness();
    await link.send(ANSWER);
    expect(sent).toEqual([ANSWER]);
    expect(closes()).toBe(1);
    await link.send(encode("later\n"));
    expect(closes()).toBe(1);
  });

  test("a line hc writes before the hello answer does not close it; the answer does", async () => {
    const { link, sent, closes } = harness();
    const before = encode('{"jsonrpc":"2.0","method":"notice","params":{}}\n');
    await link.send(before);
    expect(closes()).toBe(0);
    await link.send(ANSWER);
    expect(sent).toEqual([before, ANSWER]);
    expect(closes()).toBe(1);
  });

  test("an answer split over several writes closes once its line is complete", async () => {
    const { link, closes } = harness();
    await link.send(ANSWER.subarray(0, 12));
    expect(closes()).toBe(0);
    await link.send(ANSWER.subarray(12));
    expect(closes()).toBe(1);
  });
});
