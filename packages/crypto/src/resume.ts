import { blake2s } from "@noble/hashes/blake2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { bytesEqual, concatBytes, utf8 } from "./encoding.ts";
import { noiseHkdf } from "./noise/symmetric-state.ts";

/**
 * The first byte of a session resume (contract v1.11 "Session resume"): a client whose socket dropped dials again and,
 * instead of a Noise handshake, names the session it still holds and where it is in it. Never a handshake kind: a
 * handshake that starts with it is refused as an unknown session kind, as before.
 */
export const RESUME_KIND = 0x04;
export const RESUME_ID_LENGTH = 16;
const MAC_LENGTH = 32;
const COUNTER_LENGTH = 4;
/** `RESUME_KIND || id (16) || sent u32 LE || received u32 LE || mac (32)`. */
export const RESUME_REQUEST_LENGTH = 1 + RESUME_ID_LENGTH + 2 * COUNTER_LENGTH + MAC_LENGTH;
/** `RESUME_KIND || sent u32 LE || received u32 LE || mac (32)`. */
export const RESUME_ANSWER_LENGTH = 1 + 2 * COUNTER_LENGTH + MAC_LENGTH;
/** How long a resume waits for the host's answer on the new socket: the handshake's own deadline. */
export const RESUME_ANSWER_TIMEOUT_MS = 10_000;

/** A session's resume identity: `id` names it on the wire, `mac` keys both messages. Both come from the handshake hash. */
export interface ResumeKeys {
  readonly id: Uint8Array;
  readonly mac: Uint8Array;
}

/** How many transport records a side has sent and opened; the position a resume carries. */
export interface RecordCounters {
  readonly sent: number;
  readonly received: number;
}

const INFO = utf8("doriface-resume-v1");
const REQUEST_LABEL = utf8("resume-request");
const ANSWER_LABEL = utf8("resume-answer");

/**
 * Derives the resume identity from the handshake hash, which only the two ends of the session know (the relay never sees
 * it): two HKDF outputs under a fixed label, the first truncated to the id.
 */
export function resumeKeys(handshakeHash: Uint8Array): ResumeKeys {
  const [id, mac] = noiseHkdf(handshakeHash, INFO, 2);
  if (id === undefined || mac === undefined) throw new Error("HKDF returned too few outputs");
  return { id: id.slice(0, RESUME_ID_LENGTH), mac };
}

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError(`not a u32: ${value}`);
  const bytes = new Uint8Array(COUNTER_LENGTH);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

const readU32 = (bytes: Uint8Array, at: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true);

const counterBytes = (counters: RecordCounters): Uint8Array => concatBytes(u32(counters.sent), u32(counters.received));

const requestMac = (keys: ResumeKeys, counters: RecordCounters): Uint8Array =>
  hmac(blake2s, keys.mac, concatBytes(REQUEST_LABEL, keys.id, counterBytes(counters)));

const answerMac = (keys: ResumeKeys, request: RecordCounters, answer: RecordCounters): Uint8Array =>
  hmac(blake2s, keys.mac, concatBytes(ANSWER_LABEL, keys.id, counterBytes(request), counterBytes(answer)));

/** Whether `bytes` has the shape of a resume request: the first client message on a session that is one. */
export const isResumeRequest = (bytes: Uint8Array): boolean =>
  bytes.byteLength === RESUME_REQUEST_LENGTH && bytes[0] === RESUME_KIND;

/** The id a request names, so the host can find the session before it checks the request against its keys. */
export function resumeRequestId(bytes: Uint8Array): Uint8Array | undefined {
  return isResumeRequest(bytes) ? bytes.slice(1, 1 + RESUME_ID_LENGTH) : undefined;
}

export function encodeResumeRequest(keys: ResumeKeys, counters: RecordCounters): Uint8Array {
  return concatBytes(Uint8Array.of(RESUME_KIND), keys.id, counterBytes(counters), requestMac(keys, counters));
}

/** The counters of a request under `keys`, or undefined when it is not one, names another session or fails its MAC. */
export function decodeResumeRequest(keys: ResumeKeys, bytes: Uint8Array): RecordCounters | undefined {
  if (!isResumeRequest(bytes)) return undefined;
  if (!bytesEqual(bytes.subarray(1, 1 + RESUME_ID_LENGTH), keys.id)) return undefined;
  const at = 1 + RESUME_ID_LENGTH;
  const counters = { sent: readU32(bytes, at), received: readU32(bytes, at + COUNTER_LENGTH) };
  const mac = bytes.subarray(at + 2 * COUNTER_LENGTH);
  return bytesEqual(mac, requestMac(keys, counters)) ? counters : undefined;
}

export function encodeResumeAnswer(keys: ResumeKeys, request: RecordCounters, answer: RecordCounters): Uint8Array {
  return concatBytes(Uint8Array.of(RESUME_KIND), counterBytes(answer), answerMac(keys, request, answer));
}

/** The host's counters from its answer to `request`, or undefined when the bytes are no answer to that request. */
export function decodeResumeAnswer(
  keys: ResumeKeys,
  request: RecordCounters,
  bytes: Uint8Array,
): RecordCounters | undefined {
  if (bytes.byteLength !== RESUME_ANSWER_LENGTH || bytes[0] !== RESUME_KIND) return undefined;
  const answer = { sent: readU32(bytes, 1), received: readU32(bytes, 1 + COUNTER_LENGTH) };
  const mac = bytes.subarray(1 + 2 * COUNTER_LENGTH);
  return bytesEqual(mac, answerMac(keys, request, answer)) ? answer : undefined;
}
