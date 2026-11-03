import { describe, expect, test } from "bun:test";
import {
  decodeHello,
  decodeReply,
  encodePairingHello,
  encodeReply,
  encodeSessionHello,
  fitLanUrls,
  MAX_EARLY_BYTES,
  PayloadError,
} from "./payloads.ts";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("handshake payloads: one JSON line, then raw stream bytes", () => {
  test("a pairing hello is exactly {v:1,name} and a line feed", () => {
    expect(text(encodePairingHello("  Pixel 9 "))).toBe('{"v":1,"name":"Pixel 9"}\n');
    expect(decodeHello("IKpsk2", encodePairingHello("Pixel 9"))).toEqual({
      kind: "pairing",
      name: "Pixel 9",
      stream: undefined,
    });
  });

  test("a name made of lone surrogates is refused when encoding, not by the line limit later", () => {
    expect(() => encodePairingHello("\ud800".repeat(64))).toThrow("lone surrogate");
  });

  test("a session hello carries early stream bytes after its line", () => {
    const early = bytes('{"jsonrpc":"2.0","id":0,"method":"hello"}\n');
    const payload = encodeSessionHello(early);
    expect(text(payload)).toBe(`{"v":1}\n${text(early)}`);
    expect(decodeHello("IK", payload)).toEqual({ kind: "session", early, stream: undefined });
  });

  test("stream: a session carries hc or mesh, a pairing only mesh", () => {
    expect(text(encodeSessionHello(undefined, "mesh"))).toBe('{"v":1,"stream":"mesh"}\n');
    expect(decodeHello("IK", encodeSessionHello(undefined, "mesh"))).toEqual({
      kind: "session",
      early: new Uint8Array(0),
      stream: "mesh",
    });
    expect(decodeHello("IK", bytes('{"v":1,"stream":"hc"}\nX'))).toEqual({
      kind: "session",
      early: bytes("X"),
      stream: "hc",
    });
    expect(text(encodePairingHello("laptop", "mesh"))).toBe('{"v":1,"name":"laptop","stream":"mesh"}\n');
    expect(decodeHello("IKpsk2", encodePairingHello("laptop", "mesh"))).toEqual({
      kind: "pairing",
      name: "laptop",
      stream: "mesh",
    });
    expect(() => encodeSessionHello(bytes("x"), "mesh")).toThrow("no early bytes");
  });

  test.each([
    ["IK", '{"v":1,"stream":"mesh"}\nearly'],
    ["IK", '{"v":1,"stream":"other"}\n'],
    ["IK", '{"v":1,"stream":7}\n'],
    ["IKpsk2", '{"v":1,"name":"a","stream":"hc"}\n'],
    ["IKpsk2", '{"v":1,"name":"a","stream":"other"}\n'],
    ["IKpsk2", '{"v":1,"name":"My Mac","stream":"mesh"}\n'],
    ["IKpsk2", '{"v":1,"name":"t7","stream":"mesh"}\n'],
    ["IKpsk2", `{"v":1,"name":"${"a".repeat(33)}","stream":"mesh"}\n`],
  ] as const)("stream: %s refuses %p", (pattern, payload) => {
    expect(() => decodeHello(pattern, bytes(payload))).toThrow(PayloadError);
  });

  test("a mesh name follows herdr's machine-name rule; a device name keeps its own rule", () => {
    expect(() => encodePairingHello("My Mac", "mesh")).toThrow(PayloadError);
    expect(decodeHello("IKpsk2", bytes('{"v":1,"name":"t0.mac_1","stream":"mesh"}\n'))).toEqual({
      kind: "pairing",
      name: "t0.mac_1",
      stream: "mesh",
    });
    expect(decodeHello("IKpsk2", encodePairingHello("My Mac"))).toEqual({
      kind: "pairing",
      name: "My Mac",
      stream: undefined,
    });
  });

  test("a reply lists IP-literal LAN URLs", () => {
    const lan = ["ws://192.0.2.10:41237/v1/e2ee", "ws://[2001:db8::1]:7766/v1/e2ee"];
    expect(text(encodeReply(lan))).toBe(`{"v":1,"lan":${JSON.stringify(lan)}}\n`);
    expect(decodeReply(encodeReply(lan))).toEqual(lan);
    expect(decodeReply(encodeReply([]))).toEqual([]);
  });

  test.each([
    ["IKpsk2", '{"v":1,"name":"a"}\nextra'],
    ["IKpsk2", '{"v":1,"name":"a\\u001b[2J"}\n'],
    ["IKpsk2", '{"v":1,"name":"bidi\\u202e"}\n'],
    ["IKpsk2", '{"v":1}\n'],
    ["IKpsk2", `{"v":1,"name":"${"x".repeat(65)}"}\n`],
    ["IK", '{"v":2}\n'],
    ["IK", "[1]\n"],
    ["IK", '{"v":1}'],
    ["IK", `{"v":1,"pad":"${"x".repeat(300)}"}\n`],
    ["IK", `{"v":1}\n${"x".repeat(MAX_EARLY_BYTES + 1)}`],
  ] as const)("%s refuses %p", (pattern, payload) => {
    expect(() => decodeHello(pattern, bytes(payload))).toThrow();
  });

  test("fitLanUrls keeps the leading URLs that fit one reply line", () => {
    const lan = Array.from({ length: 8 }, (_, i) => `ws://[2001:db8:1234:5678:9abc:def0:1234:56${i}0]:65535/v1/e2ee`);
    const fitted = fitLanUrls(lan);
    expect(fitted.length).toBeGreaterThan(0);
    expect(fitted.length).toBeLessThan(lan.length);
    expect(fitted).toEqual(lan.slice(0, fitted.length));
    expect(decodeReply(encodeReply(fitted))).toEqual(fitted);
    expect(fitLanUrls(lan.slice(0, 2))).toEqual(lan.slice(0, 2));
  });

  test("a reply keeps an explicit default port", () => {
    const lan = ["ws://192.0.2.10:80/v1/e2ee"];
    expect(decodeReply(encodeReply(lan))).toEqual(lan);
  });

  test.each([
    ["ws://doriface.local:7766/v1/e2ee"],
    ["wss://192.0.2.10:7766/v1/e2ee"],
    ["ws://192.0.2.10/v1/e2ee"],
    ["ws://192.0.2.10:7766/v1/hc"],
    ["ws://user:pass@192.0.2.10:7766/v1/e2ee"],
    ["ws://192.0.2.10:7766/v1/e2ee?x=1"],
    ["ws://192.0.2.10:7766/v1/e2ee#x"],
    ["ws://192.0.2.10:0/v1/e2ee"],
    ["ws://999.0.2.10:7766/v1/e2ee"],
    ["ws://[fe80::1%25en0]:7766/v1/e2ee"],
  ])("a reply refuses %p", (url) => {
    expect(() => encodeReply([url])).toThrow();
    expect(() => decodeReply(bytes(`{"v":1,"lan":["${url}"]}\n`))).toThrow();
  });

  test("too many early bytes are refused when encoding", () => {
    expect(() => encodeSessionHello(new Uint8Array(MAX_EARLY_BYTES + 1))).toThrow();
  });
});
