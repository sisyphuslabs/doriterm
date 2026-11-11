import type { ReleaseBucket, RequestContext } from "./bindings.ts";
import { isCounted, recordDownload, requestFacts } from "./datapoint.ts";
import { ADDED_LINE, FILE_LINE } from "./feed-lines.ts";
import { type Channel, GITHUB_REPOSITORY, githubAssetUrl, isReleaseFile, isVersion, pointerKey } from "./names.ts";
import { text } from "./serve-release.ts";

const FEED_TTL_SECONDS = 60;

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/**
 * GitHub's latest release feed as get.doriterm.com serves it before a channel's first mirror (#1969): every file it
 * names becomes its absolute GitHub Releases URL, which electron-updater's generic provider downloads as given. The
 * feed must name one version and only plain release file names, else it is refused (null). No stagingPercentage is
 * added, so it is offered to every install, as GitHub's own feed is. v0.1.17 shipped reading only this host, so this
 * is what lets those installs update before anything is mirrored.
 */
export function githubFeed(stored: string): string | null {
  const lines = stored.replaceAll("\r\n", "\n").split("\n");
  const versions = lines.flatMap((line) => /^version: (\S+)\s*$/.exec(line)?.slice(1) ?? []);
  const [version] = versions;
  if (versions.length !== 1 || version === undefined || !isVersion(version)) return null;
  const out: string[] = [];
  for (const line of lines) {
    if (ADDED_LINE.test(line)) continue;
    const file = FILE_LINE.exec(line);
    if (file === null) {
      out.push(line);
      continue;
    }
    const [, prefix = "", value = ""] = file;
    if (!isReleaseFile(value.trim())) return null;
    out.push(`${prefix}${githubAssetUrl(version, value.trim())}`);
  }
  while (out.at(-1) === "") out.pop();
  const composed = `${out.join("\n")}\n`;
  return namesOnly(composed, version) ? composed : null;
}

/**
 * The composed feed read back as YAML, as electron-updater reads it: its version, and every file URL it would download,
 * must be this release's on GitHub. Any entry the line rewrite missed (flow style, a quoted key, a tab) fails here.
 */
function namesOnly(composed: string, version: string): boolean {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(composed);
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  if (String(field(parsed, "version")) !== version) return false;
  const files: unknown = field(parsed, "files") ?? [];
  if (!Array.isArray(files)) return false;
  const urls = [...files.map((file: unknown) => field(file, "url")), field(parsed, "path")].filter(
    (u) => u !== undefined,
  );
  const prefix = githubAssetUrl(version, "");
  return urls.every(
    (url) => typeof url === "string" && url.startsWith(prefix) && isReleaseFile(url.slice(prefix.length)),
  );
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
