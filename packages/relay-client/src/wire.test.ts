import { describe, expect, test } from "bun:test";
import {
  authMessage,
  base32,
  decodeMux,
  decodePairSlotAck,
  decodePairSlotRequest,
  encodeClose,
  encodeData,
  encodeOpen,
  encodePairSlotAck,
  encodePairSlotRequest,
  encodeSignedPairSlotRequest,
  fromBase64Url,
  HOST_ID_PATTERN,
  hostIdOf,
  MuxError,
  MuxType,
  normalizePairCode,
  parseAck,
  pairSlotOf,
  PairSlotAckStatus,
  pairSlotStatement,
  relayOriginOf,
  SIGNED_PAIR_SLOT_BYTES,
  toBase64Url,
} from "./wire/index.ts";

const encoder = new TextEncoder();

describe("mux frames", () => {
  test("OPEN, DATA and CLOSE round-trip with the sessionId in u32 LE", () => {
    const payload = crypto.getRandomValues(new Uint8Array(300));
    expect([...encodeOpen(0x0102_0304)]).toEqual([1, 4, 3, 2, 1]);
    expect(decodeMux(encodeOpen(0xffff_ffff))).toEqual({ type: MuxType.Open, sessionId: 0xffff_ffff });
    expect([...encodeOpen(7, "AB3")]).toEqual([1, 7, 0, 0, 0, 0x41, 0x42, 0x33]);
    expect(decodeMux(encodeOpen(7, "AB3"))).toEqual({ type: MuxType.Open, sessionId: 7, pairSlot: "AB3" });
    expect(decodeMux(encodeData(7, payload))).toEqual({ type: MuxType.Data, sessionId: 7, payload });
    expect([...encodeClose(9, 4404)]).toEqual([3, 9, 0, 0, 0, 0x34, 0x11]);
    expect(decodeMux(encodeClose(9, 4404))).toEqual({ type: MuxType.Close, sessionId: 9, code: 4404 });
  });

  test("malformed frames are rejected", () => {
    for (const bad of [
      [2, 0, 0],
      [1, 0, 0, 0, 0, 9],
      [1, 0, 0, 0, 0, 0x41, 0x42, 0x55],
      [3, 0, 0, 0, 0, 1],
      [9, 0, 0, 0, 0],
    ]) {
      expect(() => decodeMux(new Uint8Array(bad))).toThrow(MuxError);
    }
    expect(() => encodeOpen(-1)).toThrow(MuxError);
  });

  test("PAIR_SLOT is a control frame on sessionId 0 only", () => {
    const onSession = new Uint8Array([4, 7, 0, 0, 0]);
    expect(() => decodeMux(onSession)).toThrow(MuxError);
    expect(decodeMux(new Uint8Array([4, 0, 0, 0, 0]))).toEqual({
      type: MuxType.PairSlot,
      sessionId: 0,
      payload: new Uint8Array(0),
    });
  });
});

describe("host identity", () => {
  test("base32 matches the RFC 4648 vectors, lower case without padding", () => {
    expect(["", "f", "fo", "foo", "foob", "fooba", "foobar"].map((text) => base32(encoder.encode(text)))).toEqual([
      "",
      "my",
      "mzxq",
      "mzxw6",
      "mzxw6yq",
      "mzxw6ytb",
      "mzxw6ytboi",
    ]);
  });

  test("hostId is base32 of the first 16 bytes of SHA-256(signPub)", async () => {
    const signPub = crypto.getRandomValues(new Uint8Array(32));
    const digest = new Bun.CryptoHasher("sha256").update(signPub).digest();
    expect(await hostIdOf(signPub)).toBe(base32(digest.subarray(0, 16)));
    expect(await hostIdOf(signPub)).toMatch(HOST_ID_PATTERN);
  });

  test("a hostId's last character carries two zero padding bits, so only one spelling per host is valid", async () => {
    const ids = await Promise.all(
      Array.from({ length: 64 }, () => hostIdOf(crypto.getRandomValues(new Uint8Array(32)))),
    );
    expect(ids.every((id) => HOST_ID_PATTERN.test(id))).toBe(true);
    expect(HOST_ID_PATTERN.test(`${"a".repeat(25)}a`)).toBe(true);
    for (const alias of ["b", "c", "d", "z", "7"])
      expect(HOST_ID_PATTERN.test(`${"a".repeat(25)}${alias}`)).toBe(false);
  });

  test("the signed message is context, relay origin, hostId and challenge concatenated", () => {
    const challenge = new Uint8Array(32).fill(7);
    expect(authMessage("wss://r.example", "abc", challenge)).toEqual(
      new Uint8Array([...encoder.encode("doriface-relay-v1wss://r.exampleabc"), ...challenge]),
    );
  });

  test("the relay origin is the dialed scheme and host with the default port dropped", () => {
    expect(relayOriginOf("https://relay-doriface.omo.dev")).toBe("wss://relay-doriface.omo.dev");
    expect(relayOriginOf("wss://relay-doriface.omo.dev:443/v1/host/x")).toBe("wss://relay-doriface.omo.dev");
    expect(relayOriginOf("http://127.0.0.1:8787/v1/host/x")).toBe("ws://127.0.0.1:8787");
    expect(() => relayOriginOf("ftp://relay.example")).toThrow();
  });

  test("base64url round-trips and rejects other alphabets", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(fromBase64Url("a+b/")).toBeUndefined();
  });
});

describe("flow-control acks", () => {
  test("parse the a:<total> text and nothing else", () => {
    expect(parseAck("a:0")).toBe(0);
    expect(parseAck("a:65536")).toBe(65_536);
    for (const bad of ["a:", "a:01", "a:-1", "a:1.5", "b:1", "ping", "a:99999999999999999"]) {
      expect(parseAck(bad)).toBeUndefined();
    }
  });
});

describe("pairing codes and slots", () => {
  test("typed codes normalize like Crockford base32", () => {
    expect(normalizePairCode("ab3k 9xqz")).toBe("AB3K9XQZ");
    expect(normalizePairCode("IlO0-0000")).toBe("11000000");
    expect(normalizePairCode("AB3K9XQ")).toBeUndefined();
    expect(normalizePairCode("AB3K9XQU")).toBeUndefined();
    expect(pairSlotOf("AB3K9XQZ")).toBe("AB3");
  });

  test("PAIR_SLOT requests and replies round-trip", () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const request = decodeMux(encodePairSlotRequest("AB3", key));
    expect(request.type).toBe(MuxType.PairSlot);
    expect(request.type === MuxType.PairSlot && decodePairSlotRequest(request.payload)).toEqual({
      slot: "AB3",
      noiseStaticPub: key,
    });
    const ack = encodePairSlotAck("AB3", PairSlotAckStatus.Taken);
    expect([...ack]).toEqual([5, 0, 0, 0, 0, 1, 0x41, 0x42, 0x33]);
    const decoded = decodeMux(ack);
    expect(decoded.type === MuxType.PairSlotAck && decodePairSlotAck(decoded.payload)).toEqual({
      slot: "AB3",
      status: 1,
    });
    expect(decodePairSlotAck(new Uint8Array([3, 0x41, 0x42, 0x33]))).toBeUndefined();
    expect(() => encodePairSlotRequest("AB", key)).toThrow(RangeError);
    expect(decodePairSlotRequest(new Uint8Array(10))).toBeUndefined();
  });

  test("the signed PAIR_SLOT is slot, key, expiresAt as u64 BE and the 64-byte signature (contract v1.8)", () => {
    const key = new Uint8Array(32).fill(9);
    const signature = new Uint8Array(64).fill(8);
    const expiresAt = 0x0102030405;
    const frame = encodeSignedPairSlotRequest("AB3", key, { expiresAt, signature });
    const payload = frame.subarray(5);
    expect(payload.byteLength).toBe(SIGNED_PAIR_SLOT_BYTES);
    expect([...payload.subarray(35, 43)]).toEqual([0, 0, 0, 1, 2, 3, 4, 5]);
    const request = decodeMux(frame);
    expect(request.type === MuxType.PairSlot && decodePairSlotRequest(request.payload)).toEqual({
      slot: "AB3",
      noiseStaticPub: key,
      signed: { expiresAt, signature },
    });
    for (const length of [36, SIGNED_PAIR_SLOT_BYTES - 1, SIGNED_PAIR_SLOT_BYTES + 1]) {
      const padded = new Uint8Array(length);
      padded.set(payload.subarray(0, Math.min(length, payload.byteLength)));
      expect(decodePairSlotRequest(padded)).toBeUndefined();
    }
    expect(() => encodeSignedPairSlotRequest("AB3", key, { expiresAt, signature: signature.subarray(1) })).toThrow();
    expect(() => encodeSignedPairSlotRequest("AB3", key, { expiresAt: 1.5, signature })).toThrow(RangeError);
  });

  test("the slot statement is the v1.8 prefix, slot, key and expiresAt", () => {
    const statement = pairSlotStatement("AB3", new Uint8Array(32).fill(1), 2);
    const prefix = new TextEncoder().encode("doriface-pair-slot-v1AB3");
    expect(statement.subarray(0, prefix.byteLength)).toEqual(prefix);
    expect(statement.byteLength).toBe(prefix.byteLength + 32 + 8);
    expect(statement.at(-1)).toBe(2);
  });
});
