import type { RequestContext } from "./bindings.ts";
import { FEED_TTL } from "./feeds.ts";
import { CORE_POINTER_KEY, coreObjectKey, isReleaseFile, isVersion } from "./names.ts";
import { IMMUTABLE, text } from "./serve-release.ts";

const contentType = (file: string): string =>
  file.endsWith(".json")
    ? "application/json"
    : file.endsWith(".sig")
      ? "text/plain; charset=utf-8"
      : "application/octet-stream";

async function serveObject(request: Request, ctx: RequestContext, key: string, file: string, cache: string) {
  const object = await ctx.env.RELEASES.get(key);
  if (object === null) return text(404, "herdr-core has no such mirrored file");
  const headers = { "Content-Type": contentType(file), "Cache-Control": cache, ETag: object.httpEtag };
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

/**
 * The herdr-core releases Doriterm vouched for (#2945), at the paths herdr's own release server uses: a host reads
 * `/core/latest.json` (or `/core/<version>/manifest.json`), then checks it against `/core/<version>/manifest.json.sig`
 * of the version it names (cached for a minute, as a rotation re-signs it), then fetches the archive the signed
 * manifest names. A version's manifest and archives never change and are cached as immutable.
 * `latest.json` is byte for byte the manifest of the version core/latest names, and has no signature route of its own:
 * one that resolved core/latest separately could pair a new manifest with an old signature while either is cached.
 */
export async function serveCore(
  request: Request,
  ctx: RequestContext,
  version: string | undefined,
  file: string,
): Promise<Response> {
  if (version !== undefined) {
    if (!isVersion(version) || !isReleaseFile(file)) return text(404, "not a herdr-core file");
    // A signature is re-signed at a key rotation (docs/releasing.md), so it is cached briefly; the bytes it covers never change.
    return serveObject(request, ctx, coreObjectKey(version, file), file, file.endsWith(".sig") ? FEED_TTL : IMMUTABLE);
  }
  if (file !== "latest.json") return text(404, "not a herdr-core file");
  const pointer = await ctx.env.RELEASES.get(CORE_POINTER_KEY);
  if (pointer === null) return text(404, "no herdr-core release is mirrored yet");
  const named: unknown = JSON.parse(await pointer.text());
  const latest = typeof named === "object" && named !== null ? Reflect.get(named, "version") : undefined;
  if (typeof latest !== "string" || !isVersion(latest)) return text(503, "core/latest names no version");
  return serveObject(request, ctx, coreObjectKey(latest, "manifest.json"), "manifest.json", FEED_TTL);
}
