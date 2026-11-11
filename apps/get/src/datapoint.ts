import type { DataPointWriter } from "./bindings.ts";
import type { Kind, RouteName } from "./names.ts";

export type Source = "r2" | "cache" | "github";

/**
 * One counted request: these nine fields and nothing else (#1969). The writer takes the event, never the request, so no
 * address, user agent, cookie or header (electron-updater's per-install `x-user-staging-id` included) can reach the
 * dataset; `requestFacts` is the only reader of the request, and it reads the two values below.
 */
export interface DownloadEvent {
  readonly kind: Kind;
  readonly route: RouteName;
  readonly source: Source;
  readonly channel: string;
  readonly version: string;
  readonly asset: string;
  readonly platform: string;
  /** Two letters from Cloudflare's request metadata, `XX` when it has none. */
  readonly country: string;
  /** A CI smoke download (user agent carries `doriterm-install-qa`), left out of every rollup. */
  readonly qa: boolean;
}

// Column order is the rollup's contract: blob1 kind, blob2 route, blob3 source, blob4 channel, blob5 version, blob6 asset,
// blob7 platform, blob8 country, blob9 "qa" for a tagged CI download.
export function recordDownload(dataset: DataPointWriter, event: DownloadEvent): void {
  dataset.writeDataPoint({
    blobs: [
      event.kind,
      event.route,
      event.source,
      event.channel,
      event.version,
      event.asset,
      event.platform,
      event.country,
      event.qa ? "qa" : "",
    ],
    doubles: [1],
    indexes: [event.kind],
  });
}

export interface RequestFacts {
  readonly country: string;
  readonly qa: boolean;
}

export function requestFacts(request: Request): RequestFacts {
  const cf: unknown = Reflect.get(request, "cf");
  const country = typeof cf === "object" && cf !== null ? Reflect.get(cf, "country") : undefined;
  return {
    country: typeof country === "string" && /^[A-Z]{2}$/.test(country) ? country : "XX",
    qa: /\bdoriterm-install-qa\b/.test(request.headers.get("User-Agent") ?? ""),
  };
}

/** A GET of the whole file or of a range from byte 0: a download manager's eight ranges count once, a HEAD never. */
export const isCounted = (request: Request): boolean =>
  request.method === "GET" && /^(?:|bytes=0-.*)$/.test(request.headers.get("Range") ?? "");
