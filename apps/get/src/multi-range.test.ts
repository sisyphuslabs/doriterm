import { expect, test } from "bun:test";
import { route } from "./index.ts";
import { multipartBody, multipartFraming } from "./multi-range.ts";
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
  route(new Request(`https://get.doriterm.com/v/0.1.17/${FILE}`, { headers: { Range: range, ...extra } }), h.ctx);

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
      const body = await new Response(multipartBody(source, base, spans, framing)).text();
      return [size, body.length === framing.length, parts(body, "B").map((part) => part.data)];
    }),
  );
  expect(results).toEqual([1, 2, 5, 7, 22].map((size) => [size, true, ["3456", "9", "cdefghijklmno"]]));
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
