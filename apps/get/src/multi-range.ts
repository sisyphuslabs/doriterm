import type { ByteRange } from "./bindings.ts";

const encoder = new TextEncoder();

/** The bytes of a multipart/byteranges answer around the parts' data: each part's header, then the closing line. */
export function multipartFraming(
  spans: readonly ByteRange[],
  size: number,
  contentType: string,
  boundary: string,
): { readonly heads: Uint8Array[]; readonly tail: Uint8Array; readonly length: number } {
  const heads = spans.map((span, index) =>
    encoder.encode(
      `${index === 0 ? "" : "\r\n"}--${boundary}\r\nContent-Type: ${contentType}\r\n` +
        `Content-Range: bytes ${span.offset}-${span.offset + span.length - 1}/${size}\r\n\r\n`,
    ),
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const length = heads.reduce(
    (sum, head, index) => sum + head.byteLength + (spans[index]?.length ?? 0),
    tail.byteLength,
  );
  return { heads, tail, length };
}

/**
 * The multipart body from `source`, the file's bytes from `base` to the end of the last span: each part's header, then
 * its bytes, skipping the bytes between parts without copying any.
 */
export function multipartBody(
  source: ReadableStream<Uint8Array>,
  base: number,
  spans: readonly ByteRange[],
  framing: { readonly heads: readonly Uint8Array[]; readonly tail: Uint8Array },
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let chunk: Uint8Array = new Uint8Array(0);
  let chunkStart = base;
  let part = 0;
  let headSent = false;
  let at = spans[0]?.offset ?? base;

  /** Enqueues what the chunk in hand allows; true once it enqueued anything or the body is complete. */
  const drain = (controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
    let progressed = false;
    for (;;) {
      const span = spans[part];
      if (span === undefined) {
        controller.enqueue(framing.tail);
        controller.close();
        return true;
      }
      if (!headSent) {
        controller.enqueue(framing.heads[part] ?? new Uint8Array(0));
        headSent = true;
        progressed = true;
      }
      const end = span.offset + span.length;
      if (at >= end) {
        part += 1;
        headSent = false;
        at = spans[part]?.offset ?? at;
        continue;
      }
      if (at >= chunkStart + chunk.byteLength) return progressed;
      const stop = Math.min(chunk.byteLength, end - chunkStart);
      controller.enqueue(chunk.subarray(at - chunkStart, stop));
      at = chunkStart + stop;
      progressed = true;
    }
  };

  const step = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    if (drain(controller)) return;
    const next = await reader.read();
    if (next.done) throw new Error("the release object ended before its last range");
    chunkStart += chunk.byteLength;
    chunk = next.value;
    return step(controller);
  };

  return new ReadableStream<Uint8Array>({
    pull: (controller) => step(controller),
    cancel: (reason) => reader.cancel(reason),
  });
}
