#!/usr/bin/env bun
/**
 * Probes a deployed landing page (apps/landing/wrangler.jsonc) against the build in apps/landing/dist: the page at / is
 * this build's index.html byte for byte with its security headers, the app mockup page and one hashed script answer, and
 * the social card is served. A probe that cannot connect, or gets anything but a 200 (redirects are not followed), is a
 * failure; the whole set is retried, since a first deploy's custom domain takes a while to resolve and answer.
 *
 * Usage: bun .github/scripts/probe-landing.ts <origin> [attempts]
 */
import { join } from "node:path";

const DIST = join(import.meta.dir, "..", "..", "apps", "landing", "dist");
const WAIT_MS = 10_000;

const header = (response: Response, name: string): string => response.headers.get(name) ?? "";

interface Probe {
  readonly path: string;
  readonly check: (response: Response, body: string) => string | undefined;
}

function probes(index: string): readonly Probe[] {
  const asset = /\/assets\/[^"]+\.js/.exec(index)?.[0];
  if (asset === undefined) throw new Error("dist/index.html names no /assets/*.js");
  return [
    {
      path: "/",
      check: (response, body) => {
        if (!header(response, "content-type").startsWith("text/html")) return "not text/html";
        // Byte-equal: an edge that injected a script into the page fails here.
        if (body !== index) return "not this build's index.html";
        if (!header(response, "content-security-policy").includes("script-src 'self'")) return "no CSP from _headers";
        if (header(response, "x-content-type-options") !== "nosniff") return "no nosniff";
        return undefined;
      },
    },
    {
      path: "/mockup/",
      check: (response) => (header(response, "content-type").startsWith("text/html") ? undefined : "not text/html"),
    },
    {
      path: asset,
      check: (response) => (header(response, "cache-control").includes("immutable") ? undefined : "not immutable"),
    },
    {
      path: "/og.png",
      check: (response) => (header(response, "content-type") === "image/png" ? undefined : "not image/png"),
    },
  ];
}

async function failuresAt(origin: string, list: readonly Probe[]): Promise<readonly string[]> {
  const results = await Promise.all(
    list.map(async (probe) => {
      try {
        const response = await fetch(new URL(probe.path, origin), { redirect: "manual" });
        const body = await response.text();
        const problem = response.status === 200 ? probe.check(response, body) : `status ${response.status}`;
        return problem === undefined ? undefined : `${probe.path}: ${problem}`;
      } catch (error) {
        // DNS not there yet, TLS not issued, connection refused: retried like any other failure.
        return `${probe.path}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }),
  );
  return results.filter((line) => line !== undefined);
}

async function run(origin: string, attempts: number, attempt = 1): Promise<void> {
  const list = probes(await Bun.file(join(DIST, "index.html")).text());
  const failures = await failuresAt(origin, list);
  if (failures.length === 0) {
    console.log(`${origin} serves this build (${list.length} probes)`);
    return;
  }
  console.log(`attempt ${attempt}/${attempts}: ${failures.join("; ")}`);
  if (attempt >= attempts) throw new Error(`${origin} does not serve this build`);
  await Bun.sleep(WAIT_MS);
  await run(origin, attempts, attempt + 1);
}

const [origin, attempts = "18"] = process.argv.slice(2);
if (origin === undefined) throw new Error("usage: bun .github/scripts/probe-landing.ts <origin> [attempts]");
await run(origin, Number(attempts));
