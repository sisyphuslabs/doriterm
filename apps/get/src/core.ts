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
 * The herdr-core releases Doriterm vouched for (#2945), at the paths herdr's own release server uses, so a host reads
 * `/core/latest.json` or `/core/<version>/manifest.json` and its `.sig`, then the archive the signed manifest names.
 * `latest.json` is the manifest of the version core/latest names; a version's files never change.
 */
export async function serveCore(
  request: Request,
  ctx: RequestContext,
  version: string | undefined,
  file: string,
): Promise<Response> {
  if (version !== undefined) {
    if (!isVersion(version) || !isReleaseFile(file)) return text(404, "not a herdr-core file");
    return serveObject(request, ctx, coreObjectKey(version, file), file, IMMUTABLE);
  }
  if (file !== "latest.json" && file !== "latest.json.sig") return text(404, "not a herdr-core file");
  const pointer = await ctx.env.RELEASES.get(CORE_POINTER_KEY);
  if (pointer === null) return text(404, "no herdr-core release is mirrored yet");
  const named: unknown = JSON.parse(await pointer.text());
  const latest = typeof named === "object" && named !== null ? Reflect.get(named, "version") : undefined;
  if (typeof latest !== "string" || !isVersion(latest)) return text(503, "core/latest names no version");
  const manifest = file === "latest.json" ? "manifest.json" : "manifest.json.sig";
  return serveObject(request, ctx, coreObjectKey(latest, manifest), manifest, FEED_TTL);
}
