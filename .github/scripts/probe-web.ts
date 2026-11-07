#!/usr/bin/env bun
/**
 * Probes a deployed web app (apps/web/wrangler.jsonc) against the build in apps/web/dist: the shell at / and at a client
 * route (/pair, the SPA fallback), the manifest's scope, the service worker and the caching headers. It retries while
 * the origin still serves something else, since a first deploy's custom domain takes a while to answer.
 *
 * Usage: bun .github/scripts/probe-web.ts <origin> [attempts]
 */
import { join } from "node:path";

const DIST = join(import.meta.dir, "..", "..", "apps", "web", "dist");
const SHOWN = ["content-type", "cache-control", "x-content-type-options", "x-frame-options", "referrer-policy"];
const WAIT_MS = 10_000;

interface Probe {
  readonly path: string;
  readonly navigate?: boolean;
  readonly check: (response: Response, body: string) => string | undefined;
}

const header = (response: Response, name: string): string => response.headers.get(name) ?? "";

/** The Content-Security-Policy that public/_headers gives every page: the deployed shell must carry exactly this one. */
function declaredPolicy(headersFile: string): string {
  const policy = /^\/\*\n(?:  .*\n)*?  Content-Security-Policy: (.+)$/m.exec(headersFile)?.[1];
  if (policy === undefined) throw new Error("dist/_headers gives /* no Content-Security-Policy");
  return policy;
}

function probes(index: string, worker: string, policy: string): readonly Probe[] {
  const asset = /\/assets\/[^"]+\.js/.exec(index)?.[0];
  if (asset === undefined) throw new Error("dist/index.html names no /assets/*.js");
  const shell = (response: Response, body: string): string | undefined => {
    if (!header(response, "content-type").startsWith("text/html")) return "not text/html";
    // Byte-equal: an edge that injected a script (Web Analytics) into the page fails here.
    if (body !== index) return "not this build's index.html";
    if (!header(response, "cache-control").includes("no-transform")) return "no no-transform";
    if (header(response, "x-content-type-options") !== "nosniff") return "no nosniff";
    if (header(response, "content-security-policy") !== policy) return "not _headers' Content-Security-Policy";
    return undefined;
  };
  return [
    { path: "/", navigate: true, check: shell },
    { path: "/pair", navigate: true, check: shell },
    {
      path: "/manifest.webmanifest",
      check: (response, body) => {
        if (!header(response, "content-type").includes("manifest+json")) return "not application/manifest+json";
        const manifest: unknown = JSON.parse(body);
        const field = (key: string): unknown =>
          typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, key) : undefined;
        return field("scope") === "/" && field("start_url") === "/" ? undefined : "scope or start_url is not /";
      },
    },
    {
      path: "/sw.js",
      check: (response, body) => {
        if (!header(response, "content-type").includes("javascript")) return "not javascript";
        if (!header(response, "cache-control").includes("no-cache")) return "cached without revalidation";
        return body === worker ? undefined : "not this build's sw.js";
      },
    },
    {
      path: asset,
      check: (response) => (header(response, "cache-control").includes("immutable") ? undefined : "not immutable"),
    },
  ];
}

async function run(origin: string, probe: Probe): Promise<{ line: string; failure: string | undefined }> {
  const headers: Record<string, string> = probe.navigate ? { accept: "text/html", "sec-fetch-mode": "navigate" } : {};
  const response = await fetch(`${origin}${probe.path}`, { headers, redirect: "manual", cache: "no-store" });
  const body = await response.text();
  const shown = SHOWN.filter((name) => response.headers.has(name)).map((name) => `${name}: ${header(response, name)}`);
  const failure = response.status === 200 ? probe.check(response, body) : `status ${response.status}`;
  return { line: `${probe.path} -> ${response.status} | ${shown.join(" | ")}`, failure };
}

const origin = (Bun.argv[2] ?? "").replace(/\/+$/, "");
const attempts = Number(Bun.argv[3] ?? "60");
if (!/^https:\/\/[^/]+$/.test(origin) || !Number.isInteger(attempts) || attempts < 1) {
  console.error("usage: bun .github/scripts/probe-web.ts <https origin> [attempts]");
  process.exit(2);
}
const checks = probes(
  await Bun.file(join(DIST, "index.html")).text(),
  await Bun.file(join(DIST, "sw.js")).text(),
  declaredPolicy(await Bun.file(join(DIST, "_headers")).text()),
);

/** One round of every probe; the next round starts WAIT_MS later, until one passes or the attempts run out. */
async function attempt(n: number): Promise<boolean> {
  const results = await Promise.all(
    checks.map((probe) =>
      run(origin, probe).catch((error: unknown) => ({ line: `${probe.path} -> error`, failure: String(error) })),
    ),
  );
  const failed = results.filter((result) => result.failure !== undefined);
  if (failed.length === 0) {
    for (const result of results) console.log(result.line);
    console.log(`${origin}: serves this build (attempt ${n})`);
    return true;
  }
  console.log(`attempt ${n}: ${failed.map((result) => `${result.line} [${result.failure}]`).join("; ")}`);
  if (n >= attempts) return false;
  await Bun.sleep(WAIT_MS);
  return attempt(n + 1);
}

if (!(await attempt(1))) {
  console.error(`::error title=Web probe::${origin} does not serve this build`);
  process.exit(1);
}
