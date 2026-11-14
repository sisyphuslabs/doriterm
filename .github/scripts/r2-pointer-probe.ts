#!/usr/bin/env bun
/**
 * A read-only probe of a channel pointer in the release bucket (#2609). It sends two signed GETs of
 * channels/<channel>.json: one with fetch's default headers (as R2Store.get sends it today, with fetch's own
 * Accept-Encoding), and one that signs `accept-encoding: identity`. For each it prints only the status and the etag,
 * content-encoding and content-length headers, so a run shows whether R2 answers a default GET with a weak ETag (W/"...")
 * that If-Match never matches. It never writes, and it prints no URL, header of its own, body or secret.
 *
 *   r2-pointer-probe.ts --bucket B --channel stable|beta
 *
 * Secrets come from the environment, as for release-r2.ts: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.
 */
import { parseArgs } from "node:util";
import { authorization, sha256Hex } from "./r2-store.ts";

export interface ProbeOptions {
  /** https://<account>.r2.cloudflarestorage.com */
  readonly endpoint: string;
  readonly bucket: string;
  readonly channel: "stable" | "beta";
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
  readonly print?: (line: string) => void;
}

const REQUESTS = [
  { label: "default", extra: {} },
  { label: "identity", extra: { "accept-encoding": "identity" } },
] as const;

/** One signed GET; the line it prints, and whether it was answered. */
async function probeOnce(
  options: ProbeOptions,
  url: URL,
  { label, extra }: (typeof REQUESTS)[number],
): Promise<{ readonly line: string; readonly answered: boolean }> {
  const { fetcher = fetch, now = () => new Date() } = options;
  const headers: Record<string, string> = {
    ...extra,
    "x-amz-date": now()
      .toISOString()
      .replaceAll(/[-:]/g, "")
      .replace(/\.\d{3}/, ""),
    "x-amz-content-sha256": sha256Hex(""),
  };
  headers["authorization"] = authorization({
    method: "GET",
    url,
    headers,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    region: "auto",
  });
  try {
    const response = await fetcher(url.href, { method: "GET", headers });
    const field = (name: string): string => response.headers.get(name) ?? "-";
    await response.body?.cancel();
    return {
      line: `${label}: status=${response.status} etag=${field("etag")} content-encoding=${field("content-encoding")} content-length=${field("content-length")}`,
      answered: true,
    };
  } catch (error) {
    // The error's message may carry the URL; its name does not.
    return { line: `${label}: request failed (${error instanceof Error ? error.name : "unknown"})`, answered: false };
  }
}

/** Sends the two GETs and prints one line for each, in order; true when both answered. */
export async function probePointer(options: ProbeOptions): Promise<boolean> {
  const { print = console.log } = options;
  const url = new URL(
    `${options.endpoint}/${encodeURIComponent(options.bucket)}/channels/${encodeURIComponent(options.channel)}.json`,
  );
  const results = await Promise.all(REQUESTS.map((request) => probeOnce(options, url, request)));
  for (const { line } of results) print(line);
  return results.every(({ answered }) => answered);
}

const fail = (message: string): never => {
  console.log(`::error title=Pointer probe::${message}`);
  process.exit(1);
};

if (import.meta.main) {
  const env = (name: string): string => process.env[name] || fail(`${name} is not set`);
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { bucket: { type: "string" }, channel: { type: "string" } },
  });
  const channel = values.channel;
  if (channel !== "stable" && channel !== "beta") fail("--channel must be stable or beta");
  const bucket = values.bucket || fail("--bucket is required");
  const answered = await probePointer({
    endpoint: `https://${env("CLOUDFLARE_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    bucket,
    channel: channel === "beta" ? "beta" : "stable",
    accessKeyId: env("R2_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
  });
  if (!answered) process.exit(1);
}
