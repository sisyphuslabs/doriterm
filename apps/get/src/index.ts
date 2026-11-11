import type { Env, EdgeCache, RequestContext } from "./bindings.ts";
import { resolveChannel } from "./channel.ts";
import { isDesktopFeed, serveDesktopFeed, serveHostManifest } from "./feeds.ts";
import { type Channel, dlFile, githubLatestUrl, isChannel, isVersionFree } from "./names.ts";
import { downloadPage } from "./page.ts";
import { runDownloadsRollup } from "./rollup.ts";
import { serveFile, text } from "./serve-release.ts";
import { serveDownloadStats } from "./stats.ts";

const RELEASE_PATH = /^\/v\/([^/]+)\/([^/]+)$/;
const DESKTOP_PATH = /^\/desktop\/([^/]+)\/(?:([^/]+)\/)?([^/]+)$/;
const HOST_PATH = /^\/host\/([^/]+)\/(?:([^/]+)\/)?([^/]+)$/;
const DL_PATH = /^\/dl\/(?:(beta)\/)?([^/]+)$/;
const INSTALL_PATH = /^\/(?:(beta)\/)?install\.sh$/;

const redirect = (location: string, source: string): Response =>
  new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store", "X-Doriterm-Source": source },
  });

async function offeredVersion(ctx: RequestContext, channel: Channel): Promise<string | null> {
  try {
    return (await resolveChannel(ctx.env.RELEASES, channel))?.version ?? null;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return null;
  }
}

/**
 * `/dl/<key>`: a 302 to the file at the channel's version, never cached, so a link follows a pointer move within a
 * minute. The redirect carries where it came from, and the `/v/` request it leads to is the one counted. Before the
 * channel's first mirror a file with a fixed name goes to GitHub's latest release, any other to the releases page.
 */
async function serveDl(request: Request, ctx: RequestContext, channel: Channel, key: string): Promise<Response> {
  if (dlFile(key, "0.0.0") === null) return text(404, "unknown download");
  const version = await offeredVersion(ctx, channel);
  if (version === null) return redirect(githubLatestUrl(isVersionFree(key) ? dlFile(key, "0.0.0") : null), "github");
  const file = dlFile(key, version) ?? key;
  const origin = new URL(request.url).origin;
  return redirect(`${origin}/v/${version}/${file}?via=dl&channel=${channel}`, "worker");
}

/** The channel's stamped install.sh, which `curl -fsSL https://get.doriterm.com | sh` runs. */
async function serveInstaller(request: Request, ctx: RequestContext, channel: Channel): Promise<Response> {
  const version = await offeredVersion(ctx, channel);
  if (version === null) return redirect(githubLatestUrl("install.sh"), "github");
  const served = await serveFile(request, ctx, { version, file: "install.sh", route: "dl", channel });
  if (served.status !== 200) return served;
  const headers = new Headers(served.headers);
  headers.set("Cache-Control", "public, max-age=60");
  headers.delete("Content-Disposition");
  return new Response(served.body, { headers });
}

async function serveRoot(request: Request, ctx: RequestContext): Promise<Response> {
  const userAgent = request.headers.get("User-Agent") ?? "";
  // curl, wget and fetch() send no Mozilla token; every browser does.
  if (!userAgent.includes("Mozilla/")) return serveInstaller(request, ctx, "stable");
  const origin = new URL(request.url).origin;
  const page = downloadPage(origin, await offeredVersion(ctx, "stable"), userAgent);
  return new Response(request.method === "HEAD" ? null : page, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function route(request: Request, ctx: RequestContext): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return text(405, "method not allowed", { Allow: "GET, HEAD" });
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === "/") return serveRoot(request, ctx);
  if (pathname === "/healthz") return text(200, "ok");
  if (pathname === "/stats/downloads") return serveDownloadStats(request, ctx);

  const install = INSTALL_PATH.exec(pathname);
  if (install !== null) return serveInstaller(request, ctx, install[1] === "beta" ? "beta" : "stable");

  const dl = DL_PATH.exec(pathname);
  if (dl?.[2] !== undefined) return serveDl(request, ctx, dl[1] === "beta" ? "beta" : "stable", dl[2]);

  const release = RELEASE_PATH.exec(pathname);
  if (release?.[1] !== undefined && release[2] !== undefined) {
    const via = url.searchParams.get("via") === "dl";
    const channel = url.searchParams.get("channel") ?? "";
    return serveFile(request, ctx, {
      version: release[1],
      file: release[2],
      route: via ? "dl" : "v",
      channel: via && isChannel(channel) ? channel : "",
    });
  }

  const desktop = DESKTOP_PATH.exec(pathname);
  if (desktop?.[1] !== undefined && desktop[3] !== undefined) {
    const [, channel, version, file] = desktop;
    if (!isChannel(channel)) return text(404, "unknown channel");
    if (version !== undefined) return serveFile(request, ctx, { version, file, route: "desktop-update", channel });
    return isDesktopFeed(file) ? serveDesktopFeed(request, ctx, channel, file) : text(404, "unknown feed");
  }

  const host = HOST_PATH.exec(pathname);
  if (host?.[1] !== undefined && host[3] !== undefined) {
    const [, channel, version, file] = host;
    if (!isChannel(channel)) return text(404, "unknown channel");
    if (version !== undefined) return serveFile(request, ctx, { version, file, route: "host-update", channel });
    if (file === "manifest.json" || file === "manifest.json.sig") {
      return serveHostManifest(request, ctx, channel, file.endsWith(".sig"));
    }
    return text(404, "unknown host file");
  }
  return text(404, "not found");
}

const isEdgeCache = (value: unknown): value is EdgeCache =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "match") === "function" &&
  typeof Reflect.get(value, "put") === "function";

function edgeCache(): EdgeCache {
  const caches: unknown = Reflect.get(globalThis, "caches");
  const cache = typeof caches === "object" && caches !== null ? Reflect.get(caches, "default") : undefined;
  if (!isEdgeCache(cache)) throw new Error("the Workers runtime has no caches.default");
  return cache;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
    try {
      return await route(request, { env, cache: edgeCache(), waitUntil: (promise) => execution.waitUntil(promise) });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return text(503, "temporarily unavailable");
    }
  },
  scheduled(_controller: unknown, env: Env, execution: ExecutionContext): void {
    execution.waitUntil(runDownloadsRollup(env));
  },
};
