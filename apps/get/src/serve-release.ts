import type { ByteRange, ReleaseBucket, RequestContext, StoredObject } from "./bindings.ts";
import { isCounted, recordDownload, requestFacts, type Source } from "./datapoint.ts";
import { groupSpans, multipartBody, multipartFraming, type PartGroup } from "./multi-range.ts";
import { classify, completeKey, githubAssetUrl, isReleaseFile, isVersion, objectKey, type RouteName } from "./names.ts";

export const IMMUTABLE = "public, max-age=31536000, immutable";

export interface FileTarget {
  readonly version: string;
  readonly file: string;
  readonly route: RouteName;
  /** The channel the request came through, empty for a direct `/v/` link. */
  readonly channel: string;
}

export const text = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  new Response(`${body}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

const CONTENT_TYPES: readonly (readonly [RegExp, string])[] = [
  [/\.(?:txt|sh|yml|sig)$/, "text/plain; charset=utf-8"],
  [/\.json$/, "application/json"],
];

function objectHeaders(object: StoredObject, file: string, source: Source): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Content-Length", String(object.size));
  headers.set("Content-Type", CONTENT_TYPES.find(([pattern]) => pattern.test(file))?.[1] ?? "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename="${file}"`);
  headers.set("Cache-Control", IMMUTABLE);
  headers.set("Accept-Ranges", "bytes");
  headers.set("X-Doriterm-Source", source);
  return headers;
}

interface RangeSpec {
  readonly start?: number;
  readonly end?: number;
}

/** One `bytes=` range; a multi-range or malformed header is ignored, so the whole file answers (RFC 9110 14.2). */
export function parseRange(header: string | null): RangeSpec | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (match === null) return null;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return null;
  if (first === "") return { end: Number(last) };
  const start = Number(first);
  if (last === "") return { start };
  const end = Number(last);
  return end < start ? null : { start, end };
}

/** The bytes a range names in a file of `size` bytes, or null when it names none (416). */
export function resolveRange(range: RangeSpec, size: number): ByteRange | null {
  if (range.start === undefined) {
    const suffix = Math.min(range.end ?? 0, size);
    return suffix === 0 ? null : { offset: size - suffix, length: suffix };
  }
  if (range.start >= size) return null;
  const end = Math.min(range.end ?? size - 1, size - 1);
  return { offset: range.start, length: end - range.start + 1 };
}

/** electron-updater's differential download asks for at most 1000 ranges a request. */
const MAX_PARTS = 1000;

/**
 * The spans of a `bytes=` header that names two or more ranges, resolved against a file of `size` bytes, or null to
 * answer the whole file instead (RFC 9110 14.2 lets a server ignore a Range): a malformed or unsatisfiable range, ranges
 * out of order or overlapping, or more than MAX_PARTS. In order and apart, as a differential update sends them, they are
 * served from one read with the gaps skipped (#2228).
 */
export function parseMultiRange(header: string | null, size: number): ByteRange[] | null {
  const specs = /^bytes=(.+)$/.exec(header ?? "")?.[1]?.split(",") ?? [];
  if (specs.length < 2 || specs.length > MAX_PARTS) return null;
  const spans: ByteRange[] = [];
  for (const spec of specs) {
    const range = parseRange(`bytes=${spec.trim()}`);
    const span = range === null ? null : resolveRange(range, size);
    const last = spans.at(-1);
    if (span === null || (last !== undefined && span.offset < last.offset + last.length)) return null;
    spans.push(span);
  }
  return spans;
}

/** Whether the header names several ranges answered in parts, judged before the file's size is known. */
export const isMultiRange = (header: string | null): boolean =>
  parseMultiRange(header, Number.MAX_SAFE_INTEGER) !== null;

type Outcome = { readonly response: Response } | { readonly fallback: string };

/** Several ranges as one multipart/byteranges answer from one R2 read, or null to answer the whole file (#2228). */
async function fromBucketInParts(
  request: Request,
  bucket: ReleaseBucket,
  key: string,
  file: string,
): Promise<Outcome | null> {
  const meta = await bucket.head(key);
  if (meta === null) return { fallback: "object-missing" };
  const ifRange = request.headers.get("If-Range");
  if (ifRange !== null && ifRange !== meta.httpEtag) return null;
  const spans = parseMultiRange(request.headers.get("Range"), meta.size);
  if (spans === null) return null;
  const groups = groupSpans(spans);
  const [firstGroup] = groups;
  if (firstGroup === undefined) return null;
  const first = await bucket.get(key, { range: firstGroup });
  if (first === null) return { fallback: "object-missing" };
  const read = async (group: PartGroup): Promise<ReadableStream<Uint8Array>> => {
    if (group === firstGroup) return first.body;
    const object = await bucket.get(key, { range: group });
    if (object === null) throw new Error(`${key} went missing between its range reads`);
    return object.body;
  };
  const headers = objectHeaders(first, file, "r2");
  const boundary = crypto.randomUUID().replaceAll("-", "");
  const framing = multipartFraming(spans, meta.size, headers.get("Content-Type") ?? "", boundary);
  headers.set("Content-Type", `multipart/byteranges; boundary=${boundary}`);
  headers.set("Content-Length", String(framing.length));
  const body = multipartBody(groups, read, framing);
  return { response: new Response(fixedLength(body, framing.length), { status: 206, headers }) };
}

/**
 * The body through the Workers runtime's FixedLengthStream, which is the only way a streamed answer carries
 * Content-Length there (#2251); a runtime without it (Bun, in the unit suite) sends the stream as it is.
 */
function fixedLength(body: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  const Fixed: unknown = Reflect.get(globalThis, "FixedLengthStream");
  if (typeof Fixed !== "function") return body;
  const stream: unknown = Reflect.construct(Fixed, [length]);
  return stream instanceof TransformStream ? body.pipeThrough(stream) : body;
}

async function fromBucket(
  request: Request,
  ctx: RequestContext,
  target: FileTarget,
  cacheKey: Request,
): Promise<Outcome> {
  const bucket = ctx.env.RELEASES;
  if ((await bucket.head(completeKey(target.version))) === null) return { fallback: "version-not-mirrored" };
  const key = objectKey(target.version, target.file);
  if (request.method === "HEAD") {
    const meta = await bucket.head(key);
    return meta === null
      ? { fallback: "object-missing" }
      : { response: new Response(null, { headers: objectHeaders(meta, target.file, "r2") }) };
  }
  const range = parseRange(request.headers.get("Range"));
  if (range !== null) {
    const meta = await bucket.head(key);
    if (meta === null) return { fallback: "object-missing" };
    const ifRange = request.headers.get("If-Range");
    if (ifRange === null || ifRange === meta.httpEtag) {
      const span = resolveRange(range, meta.size);
      if (span === null)
        return { response: text(416, "range not satisfiable", { "Content-Range": `bytes */${meta.size}` }) };
      const object = await bucket.get(key, { range: span });
      if (object === null) return { fallback: "object-missing" };
      const headers = objectHeaders(object, target.file, "r2");
      headers.set("Content-Length", String(span.length));
      headers.set("Content-Range", `bytes ${span.offset}-${span.offset + span.length - 1}/${meta.size}`);
      return { response: new Response(object.body, { status: 206, headers }) };
    }
  }
  if (isMultiRange(request.headers.get("Range"))) {
    const multipart = await fromBucketInParts(request, bucket, key, target.file);
    if (multipart !== null) return multipart;
  }
  const object = await bucket.get(key);
  if (object === null) return { fallback: "object-missing" };
  const headers = objectHeaders(object, target.file, "r2");
  const [served, cached] = object.body.tee();
  ctx.waitUntil(ctx.cache.put(cacheKey, new Response(cached, { headers })));
  return { response: new Response(served, { headers }) };
}

/**
 * A release file from R2 through the edge cache, for `/v/`, `/desktop/<channel>/<version>/` and
 * `/host/<channel>/<version>/` alike. While the version has no `.complete` marker, or R2 fails, the answer is a 302 to
 * the same file on GitHub Releases.
 */
export async function serveFile(request: Request, ctx: RequestContext, target: FileTarget): Promise<Response> {
  if (!isVersion(target.version) || !isReleaseFile(target.file)) return text(404, "unknown release file");
  const asset = classify(target.version, target.file);
  const facts = requestFacts(request);
  const count = (source: Source): void => {
    if (asset === null || !asset.counted || !isCounted(request)) return;
    recordDownload(ctx.env.DOWNLOADS, {
      kind: asset.kind,
      route: target.route,
      source,
      channel: target.channel,
      version: target.version,
      asset: target.file,
      platform: asset.platform,
      ...facts,
    });
  };

  // One cache entry per file whatever path reached it; only a whole-file GET fills it, and the cache answers a Range
  // from it itself. If-Range goes to R2, which knows the current ETag, and so do several ranges, which R2 answers in parts.
  const cacheKey = new Request(`${new URL(request.url).origin}/v/${target.version}/${target.file}`);
  const rangeHeader = request.headers.get("Range");
  if (request.method === "GET" && request.headers.get("If-Range") === null && !isMultiRange(rangeHeader)) {
    // Several ranges not answered in parts get the whole file, so the cache is asked for the whole file (#2251).
    const single = rangeHeader !== null && !rangeHeader.includes(",");
    const cached = await ctx.cache.match(
      single ? new Request(cacheKey, { headers: { Range: rangeHeader } }) : cacheKey,
    );
    if (cached !== undefined) {
      count("cache");
      const headers = new Headers(cached.headers);
      headers.set("X-Doriterm-Source", "cache");
      return new Response(cached.body, { status: cached.status, headers });
    }
  }

  let outcome: Outcome;
  try {
    outcome = await fromBucket(request, ctx, target, cacheKey);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    outcome = { fallback: "r2-error" };
  }
  if ("fallback" in outcome) {
    count("github");
    return new Response(null, {
      status: 302,
      headers: {
        Location: githubAssetUrl(target.version, target.file),
        "Cache-Control": "no-store",
        "X-Doriterm-Source": "github",
        "X-Doriterm-Fallback": outcome.fallback,
      },
    });
  }
  if (outcome.response.status < 300) count("r2");
  return outcome.response;
}
