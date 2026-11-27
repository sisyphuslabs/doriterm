import { TAG_LENGTH } from "./noise/cipher-state.ts";

const REQUEST = 1024;
const RESPONSE = 65536 - TAG_LENGTH;
const LENGTH = 8;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const RESTORE_REQUEST_BYTES = REQUEST + TAG_LENGTH;
export const RESTORE_RESPONSE_BYTES = RESPONSE + TAG_LENGTH;

export function encodeRestoreFrame(
  kind: "request" | "response",
  json: unknown,
  data = new Uint8Array(0),
): Uint8Array<ArrayBuffer> {
  const size = kind === "request" ? REQUEST : RESPONSE;
  const bytes = encoder.encode(JSON.stringify(json));
  if (bytes.byteLength + data.byteLength > size - LENGTH) throw new RangeError("restore frame is over the bound");
  const frame = new Uint8Array(size);
  const lengths = new DataView(frame.buffer);
  lengths.setUint32(0, bytes.byteLength);
  lengths.setUint32(4, data.byteLength);
  frame.set(bytes, LENGTH);
  frame.set(data, LENGTH + bytes.byteLength);
  return frame;
}

export function decodeRestoreFrame(
  kind: "request" | "response",
  frame: Uint8Array,
): {
  readonly json: unknown;
  readonly data: Uint8Array;
} {
  const size = kind === "request" ? REQUEST : RESPONSE;
  if (frame.byteLength !== size) throw new RangeError("restore frame has a wrong size");
  const lengths = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = lengths.getUint32(0);
  const dataLength = lengths.getUint32(4);
  const end = LENGTH + length + dataLength;
  if (length < 1 || end > size || frame.subarray(end).some((byte) => byte !== 0))
    throw new RangeError("restore frame has a wrong length or padding");
  return {
    json: JSON.parse(decoder.decode(frame.subarray(LENGTH, LENGTH + length))),
    data: frame.subarray(LENGTH + length, end),
  };
}
