import { describe, expect, test } from "bun:test";
import type { ByteLink } from "@doriface/crypto";
import { MAX_LINE_BYTES, type MeshMessage, meshChannel } from "./sync-lines.ts";

function link(): { link: ByteLink; push: (text: string | Uint8Array) => void; closes: (number | undefined)[] } {
  const listeners = new Set<(bytes: Uint8Array) => void>();
  const closes: (number | undefined)[] = [];
  const byteLink: ByteLink = {
    send: () => undefined,
    onData: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose: () => () => undefined,
    close: (code) => void closes.push(code),
  };
  const push = (text: string | Uint8Array): void => {
    const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
    for (const listener of listeners) listener(bytes);
  };
  return { link: byteLink, push, closes };
}

describe("a mesh stream over a session's bytes (section 5.2)", () => {
  test.each([
    ["not JSON", "not json\n"],
    ["no t", '{"x":1}\n'],
    ["a want of numbers", '{"t":"want","hashes":[1]}\n'],
    ["a hello of another version", '{"t":"hello","v":1,"mesh":"m","heads":[],"n":{}}\n'],
    ["an unsigned record", '{"t":"records","records":[{"body":1}]}\n'],
  ])("%s closes the session 4400 and delivers nothing", (_name, line) => {
    const end = link();
    const received: MeshMessage[] = [];
    meshChannel(end.link).onMessage((message) => received.push(message));
    end.push(line);
    expect(end.closes).toEqual([4400]);
    expect(received).toEqual([]);
  });

  test("a line past 256 KiB closes 4400, with or without its LF", () => {
    for (const bytes of [
      new Uint8Array(MAX_LINE_BYTES + 10).fill(0x61),
      new TextEncoder().encode(`{"t":"done","pad":"${"a".repeat(MAX_LINE_BYTES)}"}\n`),
    ]) {
      const end = link();
      meshChannel(end.link);
      end.push(bytes);
      expect(end.closes).toEqual([4400]);
    }
  });

  test("a line of exactly 256 KiB is delivered", () => {
    const end = link();
    const received: MeshMessage[] = [];
    meshChannel(end.link).onMessage((message) => received.push(message));
    const shell = '{"t":"done","pad":""}\n';
    end.push(`{"t":"done","pad":"${"a".repeat(MAX_LINE_BYTES - shell.length)}"}\n`);
    expect(end.closes).toEqual([]);
    expect(received).toEqual([{ t: "done" }]);
  });
});
