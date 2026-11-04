import { PAIR_SLOT_LENGTH, PAIR_SLOT_PATTERN } from "./pair-code.ts";

/**
 * Relay <-> host multiplexing frame: `[type u8][sessionId u32 LE][payload]`.
 * OPEN has no payload, or the 3 slot characters for a pairing session; DATA carries opaque bytes; CLOSE carries a u16
 * LE close code. PAIR_SLOT and PAIR_SLOT_ACK are control frames on sessionId 0; their payloads are in pair-slot.ts.
 * CREDIT carries a u32 LE count of session bytes the peer consumed (credit.ts); only peers that opted in see it.
 * PASS (sessionId 0) carries the relay's clock and a pass relay to host, and is empty host to relay (a request); only
 * uplinks dialed with `?pass=1` see it (pass.ts).
 */

export const MuxType = { Open: 1, Data: 2, Close: 3, PairSlot: 4, PairSlotAck: 5, Credit: 6, Pass: 7 } as const;
export type MuxType = (typeof MuxType)[keyof typeof MuxType];

export const MUX_HEADER_BYTES = 5;

export type MuxFrame =
  | { readonly type: typeof MuxType.Open; readonly sessionId: number; readonly pairSlot?: string }
  | { readonly type: typeof MuxType.Data; readonly sessionId: number; readonly payload: Uint8Array }
  | { readonly type: typeof MuxType.Close; readonly sessionId: number; readonly code: number }
  | { readonly type: typeof MuxType.PairSlot; readonly sessionId: number; readonly payload: Uint8Array }
  | { readonly type: typeof MuxType.PairSlotAck; readonly sessionId: number; readonly payload: Uint8Array }
  | { readonly type: typeof MuxType.Credit; readonly sessionId: number; readonly bytes: number }
  | { readonly type: typeof MuxType.Pass; readonly sessionId: number; readonly payload: Uint8Array };

export class MuxError extends Error {
  override readonly name = "MuxError";
}

export function muxHeader(type: MuxType, sessionId: number, payloadBytes: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(sessionId) || sessionId < 0 || sessionId > 0xffff_ffff) {
    throw new MuxError(`sessionId ${sessionId} is not a u32`);
  }
  const out = new Uint8Array(MUX_HEADER_BYTES + payloadBytes);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setUint32(1, sessionId, true);
  return out;
}

/** OPEN for a session; `pairSlot` marks an IKpsk2 pairing session dialed with `?pair=<slot>`. */
export function encodeOpen(sessionId: number, pairSlot?: string): Uint8Array<ArrayBuffer> {
  if (pairSlot === undefined) return muxHeader(MuxType.Open, sessionId, 0);
  if (!PAIR_SLOT_PATTERN.test(pairSlot)) throw new MuxError(`${JSON.stringify(pairSlot)} is not a pairing slot`);
  const out = muxHeader(MuxType.Open, sessionId, PAIR_SLOT_LENGTH);
  out.set(new TextEncoder().encode(pairSlot), MUX_HEADER_BYTES);
  return out;
}

export function encodeData(sessionId: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = muxHeader(MuxType.Data, sessionId, payload.byteLength);
  out.set(payload, MUX_HEADER_BYTES);
  return out;
}

export function encodeClose(sessionId: number, code: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(code) || code < 0 || code > 0xffff) throw new MuxError(`close code ${code} is not a u16`);
  const out = muxHeader(MuxType.Close, sessionId, 2);
  new DataView(out.buffer).setUint16(MUX_HEADER_BYTES, code, true);
  return out;
}

/** The host's pass request: an empty PASS frame on sessionId 0. */
export const encodePassRequest = (): Uint8Array<ArrayBuffer> => muxHeader(MuxType.Pass, 0, 0);

export function encodeCredit(sessionId: number, bytes: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > 0xffff_ffff) throw new MuxError(`credit ${bytes} is not a u32`);
  const out = muxHeader(MuxType.Credit, sessionId, 4);
  new DataView(out.buffer).setUint32(MUX_HEADER_BYTES, bytes, true);
  return out;
}

function decodeOpen(sessionId: number, payload: Uint8Array): MuxFrame {
  if (payload.byteLength === 0) return { type: MuxType.Open, sessionId };
  const pairSlot = payload.byteLength === PAIR_SLOT_LENGTH ? new TextDecoder().decode(payload) : "";
  if (!PAIR_SLOT_PATTERN.test(pairSlot))
    throw new MuxError(`OPEN carries ${payload.byteLength} bytes that are not a slot`);
  return { type: MuxType.Open, sessionId, pairSlot };
}

/** Decodes one frame. DATA payloads are zero-copy views of `bytes`. */
export function decodeMux(bytes: Uint8Array): MuxFrame {
  if (bytes.byteLength < MUX_HEADER_BYTES) throw new MuxError(`frame of ${bytes.byteLength} bytes has no header`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0);
  const sessionId = view.getUint32(1, true);
  const rest = bytes.byteLength - MUX_HEADER_BYTES;
  switch (type) {
    case MuxType.Open:
      return decodeOpen(sessionId, bytes.subarray(MUX_HEADER_BYTES));
    case MuxType.Data:
      return { type, sessionId, payload: bytes.subarray(MUX_HEADER_BYTES) };
    case MuxType.PairSlot:
    case MuxType.PairSlotAck:
    case MuxType.Pass:
      if (sessionId !== 0) throw new MuxError(`type ${type} is a control frame on sessionId 0, got ${sessionId}`);
      return { type, sessionId, payload: bytes.subarray(MUX_HEADER_BYTES) };
    case MuxType.Close:
      if (rest !== 2) throw new MuxError(`CLOSE payload must be 2 bytes, got ${rest}`);
      return { type, sessionId, code: view.getUint16(MUX_HEADER_BYTES, true) };
    case MuxType.Credit:
      if (rest !== 4) throw new MuxError(`CREDIT payload must be 4 bytes, got ${rest}`);
      return { type, sessionId, bytes: view.getUint32(MUX_HEADER_BYTES, true) };
    default:
      throw new MuxError(`unknown frame type ${type}`);
  }
}
