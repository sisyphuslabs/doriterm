import type { RequestContext } from "./bindings.ts";
import { type Resolved, resolveChannel } from "./channel.ts";
import { isCounted, recordDownload, requestFacts } from "./datapoint.ts";
import { ADDED_LINE, placeLines } from "./feed-lines.ts";
import { neverPublished, serveGithubFeed } from "./github-feed.ts";
import { type Channel, hostManifestKey, isReleaseFile, objectKey } from "./names.ts";
import { text } from "./serve-release.ts";

/** electron-updater's feed per platform, as release.yml merges them, with the platform the count files it under. */
export const DESKTOP_FEEDS: Readonly<Record<string, string>> = {
  "latest-mac.yml": "mac",
  "latest.yml": "win",
  "latest-linux.yml": "linux-x64",
  "latest-linux-arm64.yml": "linux-arm64",
};

export const isDesktopFeed = (file: string): boolean => Object.hasOwn(DESKTOP_FEEDS, file);

const FEED_TTL = "public, max-age=60";

/**
 * A stored `latest*.yml` as a channel serves it: each relative `url` and `path` becomes `<version>/<file>`, so the
 * updater fetches it under `/desktop/<channel>/`; `stagingPercentage` carries the pointer's rollout, which
 * electron-updater's isStagingMatch compares with the install's own id; `minimumVersion` is the self-update floor. A
 * feed that names another version or a file outside the release is refused (null), never passed through. Only a
 * `files` item's `url` and the top-level `path` name files: the same text inside `releaseNotes` is left as it is.
 */
export function composeFeed(stored: string, resolved: Resolved): string | null {
  const lines = stored.replaceAll("\r\n", "\n").split("\n");
  if (!lines.some((line) => line.trim() === `version: ${resolved.version}`)) return null;
  const placed = placeLines(lines);
  if (placed === null) return null;
  const out: string[] = [];
  for (const [index, line] of lines.entries()) {
    const place = placed[index];
    if (ADDED_LINE.test(line)) continue;
    if (place?.at !== "file") {
      out.push(line);
      continue;
    }
    if (!isReleaseFile(place.value.trim())) return null;
    out.push(`${place.prefix}${resolved.version}/${place.value.trim()}`);
  }
  while (out.at(-1) === "") out.pop();
  out.push(`stagingPercentage: ${resolved.rollout}`);
  if (resolved.minimum !== undefined) out.push(`minimumVersion: ${resolved.minimum}`);
  return `${out.join("\n")}\n`;
}

async function offeredOrRefusal(ctx: RequestContext, channel: Channel): Promise<Resolved | Response> {
  try {
    return (await resolveChannel(ctx.env.RELEASES, channel)) ?? text(404, `the ${channel} channel has no release yet`);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return text(503, "release storage unavailable");
  }
}

interface MirroredFeed {
  readonly offered: Resolved;
  readonly stored: string | null;
}

/** The channel's offer and its stored feed; null before any offer, "unavailable" when an R2 read fails. */
async function readMirroredFeed(
  ctx: RequestContext,
  channel: Channel,
  feed: string,
): Promise<MirroredFeed | null | "unavailable"> {
  try {
    const offered = await resolveChannel(ctx.env.RELEASES, channel);
    if (offered === null) return null;
    const stored = await ctx.env.RELEASES.get(objectKey(offered.version, feed));
    return { offered, stored: stored === null ? null : await stored.text() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return "unavailable";
  }
}

export async function serveDesktopFeed(
  request: Request,
  ctx: RequestContext,
  channel: Channel,
  feed: string,
): Promise<Response> {
  const github = () => serveGithubFeed(request, ctx, channel, feed, DESKTOP_FEEDS[feed] ?? "");
  const mirrored = await readMirroredFeed(ctx, channel, feed);
  // GitHub's own latest feed before the channel's first mirror (#2074: v0.1.17 reads only this host), and whenever an R2
  // read fails, so an installed app still sees the release (#2123).
  if (mirrored === "unavailable") return github();
  if (mirrored === null) {
    let unpublished = true;
    try {
      unpublished = await neverPublished(ctx.env.RELEASES, channel);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    return unpublished ? github() : text(404, `the ${channel} channel has no release yet`);
  }
  const { offered, stored } = mirrored;
  if (stored === null) return text(404, `${offered.version} has no ${feed}`);
  const body = composeFeed(stored, offered);
  if (body === null) return text(502, `${offered.version}'s ${feed} does not describe that release`);
  if (isCounted(request)) {
    recordDownload(ctx.env.DOWNLOADS, {
      kind: "check",
      route: "desktop-update",
      source: "r2",
      channel,
      version: offered.version,
      asset: feed,
      platform: DESKTOP_FEEDS[feed] ?? "",
      ...requestFacts(request),
    });
  }
  return new Response(request.method === "HEAD" ? null : body, {
    headers: { "Content-Type": "text/yaml; charset=utf-8", "Cache-Control": FEED_TTL },
  });
}

const manifestVersion = (body: string): unknown => {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null ? Reflect.get(value, "version") : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

/**
 * The host's manifest and its detached Ed25519 signature, byte for byte as the release signed them. The Worker cannot
 * sign, so it serves the stored pair only while the manifest names the version the channel offers; between a pointer
 * move and its re-signed manifest (or after a yank) the answer is 503 and the host keeps the version it runs.
 */
export async function serveHostManifest(
  request: Request,
  ctx: RequestContext,
  channel: Channel,
  signature: boolean,
): Promise<Response> {
  const offered = await offeredOrRefusal(ctx, channel);
  if (offered instanceof Response) return offered;
  const key = hostManifestKey(offered.channel);
  const [manifest, sig] = await Promise.all([ctx.env.RELEASES.get(key), ctx.env.RELEASES.get(`${key}.sig`)]);
  if (manifest === null || sig === null) return text(404, `the ${channel} channel has no host manifest yet`);
  const body = await manifest.text();
  if (manifestVersion(body) !== offered.version) return text(503, "the host manifest is being updated");
  if (!signature && isCounted(request)) {
    recordDownload(ctx.env.DOWNLOADS, {
      kind: "check",
      route: "host-update",
      source: "r2",
      channel,
      version: offered.version,
      asset: "manifest.json",
      platform: "",
      ...requestFacts(request),
    });
  }
  const headers = {
    "Content-Type": signature ? "text/plain; charset=utf-8" : "application/json",
    "Cache-Control": FEED_TTL,
  };
  if (request.method === "HEAD") return new Response(null, { headers });
  return new Response(signature ? await sig.text() : body, { headers });
}
