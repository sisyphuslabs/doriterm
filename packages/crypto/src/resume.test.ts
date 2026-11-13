import { describe, expect, test } from "bun:test";
import { RecordRing } from "./record-ring.ts";
import {
  decodeResumeAnswer,
  decodeResumeRequest,
  encodeResumeAnswer,
  encodeResumeRequest,
  isResumeRequest,
  RESUME_ANSWER_LENGTH,
  RESUME_ID_LENGTH,
  RESUME_KIND,
  RESUME_REQUEST_LENGTH,
  resumeKeys,
  resumeRequestId,
} from "./resume.ts";

const hash = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

describe("resume keys", () => {
  test("come from the handshake hash alone: the same hash gives the same id and mac key, another hash others", () => {
    const a = resumeKeys(hash(1));
    expect(resumeKeys(hash(1))).toEqual(a);
    expect(a.id.byteLength).toBe(RESUME_ID_LENGTH);
    expect(a.mac.byteLength).toBe(32);
    const b = resumeKeys(hash(2));
    expect(b.id).not.toEqual(a.id);
    expect(b.mac).not.toEqual(a.mac);
  });
});

describe("resume request", () => {
  const keys = resumeKeys(hash(3));

  test("round-trips its counters, names the session, and is recognised by shape", () => {
    const request = encodeResumeRequest(keys, { sent: 7, received: 1_000_000 });
    expect(request.byteLength).toBe(RESUME_REQUEST_LENGTH);
    expect(request[0]).toBe(RESUME_KIND);
    expect(isResumeRequest(request)).toBe(true);
    expect(resumeRequestId(request)).toEqual(keys.id);
    expect(decodeResumeRequest(keys, request)).toEqual({ sent: 7, received: 1_000_000 });
  });

  test("is refused under another session's keys, with a flipped counter, with a flipped mac, or at the wrong length", () => {
    const request = encodeResumeRequest(keys, { sent: 7, received: 9 });
    expect(decodeResumeRequest(resumeKeys(hash(4)), request)).toBeUndefined();
    const flipped = (at: number): Uint8Array => {
      const copy = request.slice();
      copy[at] = (copy[at] ?? 0) ^ 1;
      return copy;
    };
    const counter = flipped(1 + RESUME_ID_LENGTH);
    expect(decodeResumeRequest(keys, counter)).toBeUndefined();
    const mac = flipped(request.byteLength - 1);
    expect(decodeResumeRequest(keys, mac)).toBeUndefined();
    expect(decodeResumeRequest(keys, request.subarray(0, request.byteLength - 1))).toBeUndefined();
    expect(isResumeRequest(request.subarray(1))).toBe(false);
    expect(resumeRequestId(Uint8Array.of(1, 2, 3))).toBeUndefined();
  });
});

describe("resume answer", () => {
  const keys = resumeKeys(hash(5));
  const request = { sent: 3, received: 4 };

  test("round-trips the host's counters and is bound to the request it answers", () => {
    const answer = encodeResumeAnswer(keys, request, { sent: 10, received: 2 });
    expect(answer.byteLength).toBe(RESUME_ANSWER_LENGTH);
    expect(decodeResumeAnswer(keys, request, answer)).toEqual({ sent: 10, received: 2 });
    expect(decodeResumeAnswer(keys, { sent: 3, received: 5 }, answer)).toBeUndefined();
    expect(decodeResumeAnswer(resumeKeys(hash(6)), request, answer)).toBeUndefined();
    expect(decodeResumeAnswer(keys, request, encodeResumeRequest(keys, request))).toBeUndefined();
  });
});

describe("RecordRing", () => {
  test("numbers records from 0 and hands back every record from a sequence number on", () => {
    const ring = new RecordRing(100);
    expect(ring.push(Uint8Array.of(1))).toBe(0);
    expect(ring.push(Uint8Array.of(2, 2))).toBe(0);
    expect(ring.next).toBe(2);
    expect(ring.from(0)?.map((record) => record.byteLength)).toEqual([1, 2]);
    expect(ring.from(1)?.map((record) => record.byteLength)).toEqual([2]);
    expect(ring.from(2)).toEqual([]);
    expect(ring.from(3)).toBeUndefined();
  });

  test("drops the oldest records past its byte cap and reports them, and no longer hands back from before them", () => {
    const ring = new RecordRing(10);
    ring.push(new Uint8Array(4));
    ring.push(new Uint8Array(4));
    expect(ring.push(new Uint8Array(4))).toBe(1);
    expect(ring.first).toBe(1);
    expect(ring.bytes).toBe(8);
    expect(ring.from(0)).toBeUndefined();
    expect(ring.from(1)?.length).toBe(2);
  });

  test("keeps one record larger than the cap on its own", () => {
    const ring = new RecordRing(10);
    ring.push(new Uint8Array(4));
    expect(ring.push(new Uint8Array(40))).toBe(1);
    expect(ring.from(1)?.length).toBe(1);
  });
});
