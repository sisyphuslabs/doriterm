import type { ByteRange } from "./bindings.ts";

/** A gap this small is cheaper to stream through than to skip with another R2 read. */
const MAX_GAP = 1024 * 1024;
/** R2 reads one multipart answer may make; past it the smallest gaps are streamed through. */
const MAX_GROUPS = 32;

/** One R2 read: the span from its first range to its last, and the ranges it serves. */
export interface PartGroup extends ByteRange {
  readonly spans: readonly ByteRange[];
}

/**
 * The ranges, in order and apart, grouped into R2 reads (#2251): a new read starts at every gap wider than `maxGap`,
 * the widest gaps first, at most `maxGroups` reads, so the bytes between far-apart ranges are never streamed.
 */
export function groupSpans(spans: readonly ByteRange[], maxGap = MAX_GAP, maxGroups = MAX_GROUPS): PartGroup[] {
  const gaps = spans.slice(1).map((span, i) => {
    const before = spans[i];
    return { at: i + 1, width: before === undefined ? 0 : span.offset - (before.offset + before.length) };
  });
  const splits = new Set(
    gaps
      .filter((gap) => gap.width > maxGap)
      .toSorted((a, b) => b.width - a.width)
      .slice(0, maxGroups - 1)
      .map((gap) => gap.at),
  );
  const groups: ByteRange[][] = [];
  for (const [index, span] of spans.entries()) {
    if (index === 0 || splits.has(index)) groups.push([]);
    groups.at(-1)?.push(span);
  }
  return groups.flatMap((group) => {
    const [first] = group;
    const last = group.at(-1);
    if (first === undefined || last === undefined) return [];
    return [{ offset: first.offset, length: last.offset + last.length - first.offset, spans: group }];
  });
}

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
 * The multipart body: each group read from R2 in turn when the body reaches it, each part's header, then its bytes,
 * skipping the bytes between parts of a group without copying any.
 */
export function multipartBody(
  groups: readonly PartGroup[],
  read: (group: PartGroup) => Promise<ReadableStream<Uint8Array>>,
  framing: { readonly heads: readonly Uint8Array[]; readonly tail: Uint8Array },
): ReadableStream<Uint8Array> {
  let group = -1;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let chunk: Uint8Array = new Uint8Array(0);
  let chunkStart = 0;
  let part = 0;
  let partInGroup = 0;
  let headSent = false;
  let at = 0;
  let progressed = false;
  let cancelled: { readonly reason: unknown } | null = null;

  /** Enqueues what the chunk in hand allows; "read" when it needs the next chunk, "group" for the next group. */
  const drain = (controller: ReadableStreamDefaultController<Uint8Array>): "read" | "group" | "done" => {
    for (;;) {
      const spans = groups[group]?.spans ?? [];
      const span = spans[partInGroup];
      if (span === undefined) return group + 1 < groups.length ? "group" : "done";
      if (!headSent) {
        controller.enqueue(framing.heads[part] ?? new Uint8Array(0));
        headSent = true;
        progressed = true;
      }
      const end = span.offset + span.length;
      if (at >= end) {
        part += 1;
        partInGroup += 1;
        headSent = false;
        at = spans[partInGroup]?.offset ?? at;
        continue;
      }
      if (at >= chunkStart + chunk.byteLength) return "read";
      const stop = Math.min(chunk.byteLength, end - chunkStart);
      controller.enqueue(chunk.subarray(at - chunkStart, stop));
      at = chunkStart + stop;
      progressed = true;
    }
  };

  /** One pull: reads until it has enqueued something, then leaves the rest to the next pull (backpressure). */
  const step = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    const state = reader === null ? "group" : drain(controller);
    if (state === "read" && progressed) {
      progressed = false;
      return;
    }
    if (state === "done") {
      reader?.releaseLock();
      controller.enqueue(framing.tail);
      controller.close();
      return;
    }
    if (state === "group") {
      // A finished group's R2 body is let go before the next opens (#2264).
      reader?.releaseLock();
      reader = null;
      group += 1;
      const next = groups[group];
      if (next === undefined) throw new Error("no range group left to read");
      const source = await read(next);
      // The client went away while this body was opening: nothing will read it.
      if (cancelled !== null) return void (await source.cancel(cancelled.reason));
      reader = source.getReader();
      chunk = new Uint8Array(0);
      chunkStart = next.offset;
      partInGroup = 0;
      at = next.spans[0]?.offset ?? next.offset;
      return step(controller);
    }
    const next = await reader?.read();
    if (next === undefined || next.done) throw new Error("the release object ended before its last range");
    chunkStart += chunk.byteLength;
    chunk = next.value;
    return step(controller);
  };

  return new ReadableStream<Uint8Array>({
    pull: (controller) => step(controller),
    cancel: (reason) => {
      cancelled = { reason };
      return reader?.cancel(reason);
    },
  });
}
