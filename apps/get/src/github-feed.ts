import type { ReleaseBucket, RequestContext } from "./bindings.ts";
import { isCounted, recordDownload, requestFacts } from "./datapoint.ts";
import { ADDED_LINE, placeLines } from "./feed-lines.ts";
import { type Channel, GITHUB_REPOSITORY, githubAssetUrl, isReleaseFile, isVersion, pointerKey } from "./names.ts";
import { text } from "./serve-release.ts";

const FEED_TTL_SECONDS = 60;

/** The line shapes of an electron-builder update feed, the file-naming url and path lines among them. */
const FEED_LINE = new RegExp(
  [
    /^version: \S+$/,
    /^files:$/,
    /^ {2}- url: [A-Za-z0-9_][A-Za-z0-9._-]*$/,
    /^ {4}sha512: [A-Za-z0-9+/]+={0,2}$/,
    /^ {4}(?:size|blockMapSize): \d+$/,
    /^path: [A-Za-z0-9_][A-Za-z0-9._-]*$/,
    /^sha512: [A-Za-z0-9+/]+={0,2}$/,
    /^releaseDate: '?[0-9T:.Z-]+'?$/,
    /^(?:stagingPercentage|minimumVersion): \S+$/,
  ]
    .map((pattern) => `(?:${pattern.source})`)
    .join("|"),
);

/**
 * GitHub's latest release feed as get.doriterm.com serves it before a channel's first mirror (#1969): every file it
 * names becomes its absolute GitHub Releases URL, which electron-updater's generic provider downloads as given. The
 * feed must consist only of the line shapes electron-builder writes, name one version and only plain release file
 * names, else it is refused (null). No stagingPercentage is
 * added, so it is offered to every install, as GitHub's own feed is. v0.1.17 shipped reading only this host, so this
 * is what lets those installs update before anything is mirrored.
 */
export function githubFeed(stored: string): string | null {
  const lines = stored.replaceAll("\r\n", "\n").split("\n");
  // Every line has one of the shapes electron-builder writes (latest*.yml since v0.1.0), nothing else: no YAML
  // parser is needed (the Workers runtime has none), and a flow-style list, a quoted key or a tab cannot match.
  if (!lines.every((line) => line === "" || FEED_LINE.test(line))) return null;
  // And in electron-builder's structure (#1981): an item or an item field outside the `files` list is refused.
  const placed = placeLines(lines);
  if (placed === null || placed.some((place) => place.at === "nested")) return null;
  const versions = lines.flatMap((line) => /^version: (\S+)$/.exec(line)?.slice(1) ?? []);
  const [version] = versions;
  if (versions.length !== 1 || version === undefined || !isVersion(version)) return null;
  const out: string[] = [];
  for (const [index, line] of lines.entries()) {
    const place = placed[index];
    if (ADDED_LINE.test(line)) continue;
    if (place?.at !== "file") {
      out.push(line);
      continue;
    }
    if (!isReleaseFile(place.value)) return null;
    out.push(`${place.prefix}${githubAssetUrl(version, place.value)}`);
  }
  while (out.at(-1) === "") out.pop();
  return `${out.join("\n")}\n`;
}

/**
 * Whether the channel has never had a pointer: beta follows stable, so beta counts only when neither has one. A channel
 * whose versions are all yanked has a pointer, and is never sent to GitHub's latest release (which could be the yank).
 */
export async function neverPublished(bucket: ReleaseBucket, channel: Channel): Promise<boolean> {
  const channels: readonly Channel[] = channel === "beta" ? ["stable", "beta"] : ["stable"];
  const heads = await Promise.all(channels.map((name) => bucket.head(pointerKey(name))));
  return heads.every((head) => head === null);
}

export async function serveGithubFeed(
  request: Request,
  ctx: RequestContext,
  channel: Channel,
  feed: string,
  platform: string,
): Promise<Response> {
  const cacheKey = new Request(`${new URL(request.url).origin}/desktop/github/${feed}`);
  let body = await (await ctx.cache.match(cacheKey))?.text();
  if (body === undefined) {
    const fetcher = ctx.fetcher ?? ((url: string) => fetch(url, { redirect: "follow" }));
    let response: Response;
    try {
      response = await fetcher(`https://github.com/${GITHUB_REPOSITORY}/releases/latest/download/${feed}`);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return text(503, "GitHub Releases did not answer");
    }
    if (!response.ok) return text(502, `GitHub Releases answered ${response.status} for ${feed}`);
    const composed = githubFeed(await response.text());
    if (composed === null) return text(502, `GitHub's ${feed} does not describe one release`);
    body = composed;
    const cached = new Response(body, { headers: { "Cache-Control": `public, max-age=${FEED_TTL_SECONDS}` } });
    ctx.waitUntil(ctx.cache.put(cacheKey, cached));
  }
  const version = /^version: (\S+)/m.exec(body)?.[1] ?? "";
  if (isCounted(request)) {
    recordDownload(ctx.env.DOWNLOADS, {
      kind: "check",
      route: "desktop-update",
      source: "github",
      channel,
      version,
      asset: feed,
      platform,
      ...requestFacts(request),
    });
  }
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "Content-Type": "text/yaml; charset=utf-8",
      "Cache-Control": `public, max-age=${FEED_TTL_SECONDS}`,
      "X-Doriterm-Source": "github",
    },
  });
}
