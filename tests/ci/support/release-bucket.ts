/**
 * One in-memory bucket that is both the mirror's ObjectStore (S3 semantics: ETags, If-None-Match, If-Match) and the
 * Worker's R2 binding, so a test can mirror a release and then ask apps/get what get.doriterm.com would answer.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ByteRange, RequestContext, StoredBody, StoredObject } from "../../../apps/get/src/bindings.ts";
import { route } from "../../../apps/get/src/index.ts";
import { FakeCache, sqliteD1 } from "../../../apps/get/src/testing/fakes.ts";
import { type ObjectStore, type PutCondition, sha256Hex, type StoredItem } from "../../../.github/scripts/r2-store.ts";
import type { GitHubAsset } from "../../../.github/scripts/release-mirror.ts";

export class MemoryBucket implements ObjectStore {
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>();
  readonly puts: string[] = [];
  /** Throws on the first put of a key matching this, after the earlier puts landed. */
  failPutOf: RegExp | null = null;

  async get(key: string): Promise<StoredItem | null> {
    const body = this.objects.get(key);
    return body === undefined ? null : { body, etag: `"${sha256Hex(body)}"` };
  }

  async put(key: string, body: Uint8Array, condition: PutCondition, _contentType: string): Promise<boolean> {
    if (this.failPutOf?.test(key)) throw new Error(`injected failure writing ${key}`);
    const existing = await this.get(key);
    if ("create" in condition && existing !== null) return false;
    if ("replace" in condition && existing?.etag !== condition.replace) return false;
    this.objects.set(key, new Uint8Array(body));
    this.puts.push(key);
    return true;
  }

  text(key: string): string | undefined {
    const body = this.objects.get(key);
    return body === undefined ? undefined : new TextDecoder().decode(body);
  }

  /** The Worker's view of the same objects. */
  readonly binding = {
    head: async (key: string): Promise<StoredObject | null> => {
      const body = this.objects.get(key);
      return body === undefined
        ? null
        : { key, size: body.byteLength, httpEtag: `"${sha256Hex(body)}"`, writeHttpMetadata: () => undefined };
    },
    get: async (key: string, options?: { readonly range: ByteRange }): Promise<StoredBody | null> => {
      const body = this.objects.get(key);
      if (body === undefined) return null;
      const slice =
        options === undefined ? body : body.slice(options.range.offset, options.range.offset + options.range.length);
      return {
        key,
        size: body.byteLength,
        httpEtag: `"${sha256Hex(body)}"`,
        writeHttpMetadata: () => undefined,
        body: new Response(slice).body ?? new ReadableStream(),
        text: async () => new TextDecoder().decode(slice),
      };
    },
  };

  /** GET a path on the Worker over this bucket, as get.doriterm.com would answer it now. */
  worker(path: string): Promise<Response> {
    const ctx: RequestContext = {
      env: {
        RELEASES: this.binding,
        DB: sqliteD1().db,
        DOWNLOADS: { writeDataPoint: () => undefined },
        ANALYTICS_DATASET: "t",
      },
      cache: new FakeCache(),
      waitUntil: () => undefined,
    };
    return route(new Request(`https://get.doriterm.com${path}`), ctx);
  }
}

export interface FakeRelease {
  readonly dir: string;
  readonly assets: GitHubAsset[];
  cleanup(): void;
}

/** A downloaded release as `gh release download` leaves it: the files, SHA256SUMS.txt, and GitHub's digests. */
export function fakeRelease(version: string, tamper?: string): FakeRelease {
  const dir = mkdtempSync(join(tmpdir(), "release-mirror-"));
  const files: Record<string, string> = {
    [`Doriterm-${version}-arm64.dmg`]: `dmg ${version}`,
    "install.sh": `#!/bin/sh\necho ${version}\n`,
    "latest-mac.yml": `version: ${version}\nfiles:\n  - url: Doriterm-${version}-arm64.dmg\npath: Doriterm-${version}-arm64.dmg\n`,
    ...Object.fromEntries(
      ["linux-x64", "linux-arm64", "mac-x64", "mac-arm64"].map((t) => [`doriface-host-${t}`, `host ${t} ${version}`]),
    ),
  };
  const sums = Object.entries(files)
    .map(([name, body]) => `${sha256Hex(body)}  ${name}\n`)
    .toSorted((a, b) => (a.split("  ")[1] ?? "").localeCompare(b.split("  ")[1] ?? ""))
    .join("");
  const all = { ...files, "SHA256SUMS.txt": sums };
  const assets = Object.entries(all).map(([name, body]) => ({ name, digest: `sha256:${sha256Hex(body)}` }));
  for (const [name, body] of Object.entries(all)) writeFileSync(join(dir, name), name === tamper ? `${body}!` : body);
  return { dir, assets, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
