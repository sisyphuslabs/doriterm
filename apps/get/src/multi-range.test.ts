import { expect, test } from "bun:test";
import { route } from "./index.ts";
import { groupSpans, multipartBody, multipartFraming } from "./multi-range.ts";
import { harness, mirror, point } from "./testing/fakes.ts";

const BYTES = "0123456789abcdefghijklmnopqrstuv";
const FILE = "Doriterm-0.1.17-arm64.dmg";

function released() {
  const h = harness();
  mirror(h.bucket, "0.1.17", { [FILE]: BYTES });
  point(h.bucket, "stable", { version: "0.1.17" });
  return h;
}

const get = (h: ReturnType<typeof harness>, range: string, extra: Record<string, string> = {}) =>
  route(
    new Request(`https://get.doriterm.com/v/0.1.17/${FILE}`, {
      headers: range === "" ? extra : { Range: range, ...extra },
    }),
    h.ctx,
  );

const shape = (groups: ReturnType<typeof groupSpans>) => groups.map((g) => [g.offset, g.length, g.spans.length]);

/** The parts of a multipart/byteranges body, read the way electron-updater's DataSplitter reads them. */
function parts(body: string, boundary: string): { range: string; data: string }[] {
  expect(body.startsWith(`--${boundary}\r\n`)).toBe(true);
  expect(body.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
  const inner = body.slice(0, -`\r\n--${boundary}--\r\n`.length);
  return inner
    .split(`--${boundary}\r\n`)
    .slice(1)
    .map((part) => {
      const [head = "", data = ""] = part.split("\r\n\r\n");
      return { range: /Content-Range: (.+)/.exec(head)?.[1] ?? "", data: data.replace(/\r\n$/, "") };
    });
}

test("several ranges answer 206 multipart/byteranges, one part per range in order, as a differential update asks (#2228)", async () => {
  const h = released();
  const response = await get(h, "bytes=2-4, 10-11,20-25,30-");
  expect(response.status).toBe(206);
  const boundary = /^multipart\/byteranges; boundary=(\S+)$/.exec(response.headers.get("Content-Type") ?? "")?.[1];
  if (boundary === undefined) throw new Error(`not multipart: ${response.headers.get("Content-Type")}`);
  expect([response.headers.get("Accept-Ranges"), response.headers.get("X-Doriterm-Source")]).toEqual(["bytes", "r2"]);
  const body = await response.text();
  expect(response.headers.get("Content-Length")).toBe(String(new TextEncoder().encode(body).byteLength));
  expect(parts(body, boundary)).toEqual([
    { range: "bytes 2-4/32", data: "234" },
    { range: "bytes 10-11/32", data: "ab" },
    { range: "bytes 20-25/32", data: "klmnop" },
    { range: "bytes 30-31/32", data: "uv" },
  ]);
  // One R2 read covers every part; the bytes between parts are skipped, not sent.
  expect(h.bucket.reads.filter((read) => read.startsWith("get "))).toEqual([`get releases/v0.1.17/${FILE}`]);
});

test("parts are cut from a body that arrives in small chunks, across every chunk boundary", async () => {
  const bytes = new TextEncoder().encode(BYTES);
  const spans = [
    { offset: 3, length: 4 },
    { offset: 9, length: 1 },
    { offset: 12, length: 13 },
  ];
  const base = 3;
  const covered = bytes.subarray(base, 25);
  const results = await Promise.all(
    [1, 2, 5, 7, 22].map(async (size) => {
      const chunks = Array.from({ length: Math.ceil(covered.length / size) }, (_, i) =>
        covered.subarray(i * size, (i + 1) * size),
      );
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
      const framing = multipartFraming(spans, bytes.length, "application/octet-stream", "B");
      const group = { offset: base, length: covered.length, spans };
      const body = await new Response(multipartBody([group], async () => source, framing)).text();
      return [size, body.length === framing.length, parts(body, "B").map((part) => part.data)];
    }),
  );
  expect(results).toEqual([1, 2, 5, 7, 22].map((size) => [size, true, ["3456", "9", "cdefghijklmno"]]));
});

test("ranges far apart are read in separate R2 reads, so the gap between them is never streamed (#2251)", async () => {
  const big = "x".repeat(3 * 1024 * 1024);
  const h = harness();
  mirror(h.bucket, "0.1.17", { [FILE]: big });
  point(h.bucket, "stable", { version: "0.1.17" });
  const response = await get(h, "bytes=0-9,20-29,2000000-2000009");
  const boundary = /boundary=(\S+)/.exec(response.headers.get("Content-Type") ?? "")?.[1] ?? "";
  expect(parts(await response.text(), boundary).map((part) => part.range)).toEqual([
    "bytes 0-9/3145728",
    "bytes 20-29/3145728",
    "bytes 2000000-2000009/3145728",
  ]);
  expect(h.bucket.reads.filter((read) => read.startsWith("get ")).length).toBe(2);
  expect(h.bucket.bytesRead).toBe(40);
});

test("one read of the body pulls only what it needs from R2, not the whole span (backpressure)", async () => {
  let pulled = 0;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled += 1;
        if (pulled > 1000) controller.close();
        else controller.enqueue(new Uint8Array(64).fill(65));
      },
    },
    { highWaterMark: 0 },
  );
  const spans = [
    { offset: 0, length: 32_000 },
    { offset: 40_000, length: 10 },
  ];
  const framing = multipartFraming(spans, 64_000, "application/octet-stream", "B");
  const reader = multipartBody([{ offset: 0, length: 40_010, spans }], async () => source, framing).getReader();
  await reader.read();
  await reader.read();
  // Every pull here settles in microtasks, so one macrotask later an unbounded pull would have read the whole span.
  await new Promise((resolve) => setImmediate(resolve));
  expect(pulled).toBeLessThan(10);
  await reader.cancel();
});

/** Two far-apart ranges whose R2 reads the test controls: the second group's body opens only when `release` is called. */
function twoGroups() {
  const spans = [
    { offset: 0, length: 4 },
    { offset: 3000, length: 4 },
  ];
  const opened: { offset: number; locked: () => boolean }[] = [];
  const secondAsked = Promise.withResolvers<void>();
  const secondCancelled = Promise.withResolvers<unknown>();
  const release = Promise.withResolvers<void>();
  const read = async (group: { readonly offset: number; readonly length: number }) => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(group.length).fill(66));
        controller.close();
      },
      cancel: (reason) => secondCancelled.resolve(reason),
    });
    opened.push({ offset: group.offset, locked: () => source.locked });
    if (group.offset === 0) return source;
    secondAsked.resolve();
    await release.promise;
    return source;
  };
  const framing = multipartFraming(spans, 4000, "application/octet-stream", "B");
  const reader = multipartBody(groupSpans(spans, 100), read, framing).getReader();
  return { reader, opened, secondAsked: secondAsked.promise, secondCancelled: secondCancelled.promise, release };
}

test("every R2 body the answer opens is cancelled or released, even one opened after a cancel (#2264)", async () => {
  const g = twoGroups();
  await g.reader.read();
  await g.reader.read();
  const nextRead = g.reader.read();
  await g.secondAsked;
  const cancelled = g.reader.cancel("client went away");
  g.release.resolve();
  expect(await g.secondCancelled).toBe("client went away");
  await cancelled;
  await nextRead;
  expect(g.opened.map((entry) => [entry.offset, entry.locked()])).toEqual([
    [0, false],
    [3000, false],
  ]);
});

test("a cancel between groups opens no further R2 read: the next group opens only when it is read (#2272)", async () => {
  const g = twoGroups();
  expect((await g.reader.read()).done).toBe(false);
  expect((await g.reader.read()).done).toBe(false);
  await g.reader.cancel("client went away");
  expect(g.opened.map((entry) => entry.offset)).toEqual([0]);
});

test("spans group by gap, and no more groups are made than the cap allows, closing the smallest gaps first", () => {
  const spans = [0, 10, 5000, 5010, 90_000, 200_000].map((offset) => ({ offset, length: 5 }));
  expect(shape(groupSpans(spans, 1000, 32))).toEqual([
    [0, 15, 2],
    [5000, 15, 2],
    [90_000, 5, 1],
    [200_000, 5, 1],
  ]);
  expect(shape(groupSpans(spans, 1000, 2))).toEqual([
    [0, 90_005, 5],
    [200_000, 5, 1],
  ]);
});

test("in the Workers runtime the multipart body goes through a FixedLengthStream, so Content-Length is sent (#2251)", async () => {
  const lengths: number[] = [];
  class FakeFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
    constructor(length: number) {
      super();
      lengths.push(length);
    }
  }
  Object.assign(globalThis, { FixedLengthStream: FakeFixedLengthStream });
  try {
    const response = await get(released(), "bytes=2-4,10-11");
    const body = await response.text();
    expect([response.status, lengths]).toEqual([206, [new TextEncoder().encode(body).byteLength]]);
  } finally {
    Reflect.deleteProperty(globalThis, "FixedLengthStream");
  }
});

test("several ranges the Worker does not answer in parts are served the whole file from the edge cache (#2251)", async () => {
  const h = released();
  await (await get(h, "")).text();
  await h.settle();
  const before = h.bucket.reads.length;
  const rejected = await Promise.all(
    ["bytes=10-11,2-4", "bytes=2-6,4-8", "bytes=2-4,x"].map(async (range) => {
      const response = await get(h, range);
      return [range, response.status, response.headers.get("X-Doriterm-Source"), await response.text()];
    }),
  );
  expect(rejected).toEqual(
    ["bytes=10-11,2-4", "bytes=2-6,4-8", "bytes=2-4,x"].map((range) => [range, 200, "cache", BYTES]),
  );
  expect(h.bucket.reads.length).toBe(before);
});

test("ranges out of order, overlapping, unsatisfiable or too many get the whole file, as before (#2228)", async () => {
  const h = released();
  const many = Array.from({ length: 1001 }, (_, i) => `${i % 32}-${i % 32}`).join(",");
  const ranges = ["bytes=10-11,2-4", "bytes=2-6,4-8", "bytes=2-4,40-50", "bytes=2-4,x", `bytes=${many}`];
  const answers = await Promise.all(
    ranges.map(async (range) => {
      const response = await get(h, range);
      return [range.slice(0, 20), response.status, await response.text()];
    }),
  );
  expect(answers).toEqual(ranges.map((range) => [range.slice(0, 20), 200, BYTES]));
  const stale = await get(h, "bytes=2-4,10-11", { "If-Range": '"other"' });
  expect([stale.status, await stale.text()]).toEqual([200, BYTES]);
});
