/** In-memory R2, D1, Analytics Engine and edge cache for the unit suite: no workerd, no wrangler, no network. */
import { Database as Sqlite } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ByteRange,
  DataPoint,
  Database,
  EdgeCache,
  Env,
  ReleaseBucket,
  RequestContext,
  Statement,
  StoredBody,
  StoredObject,
} from "../bindings.ts";

export class FakeBucket implements ReleaseBucket {
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>();
  failWith: Error | null = null;
  /** Fails only the reads of this key, or only one operation on it ("head <key>"): a partial R2 outage. */
  failKey: string | null = null;
  /** Every key read, in order, with the operation. */
  readonly reads: string[] = [];
  /** The bytes every `get` has returned, ranges included. */
  bytesRead = 0;

  put(key: string, body: string | Uint8Array<ArrayBuffer>): void {
    this.objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
  }

  delete(key: string): void {
    this.objects.delete(key);
  }

  private read(op: string, key: string): Uint8Array<ArrayBuffer> | undefined {
    this.reads.push(`${op} ${key}`);
    if (this.failWith !== null) throw this.failWith;
    if (key === this.failKey || `${op} ${key}` === this.failKey) throw new Error(`R2 failed reading ${key}`);
    return this.objects.get(key);
  }

  private meta(key: string, size: number): StoredObject {
    return { key, size, httpEtag: `"etag-${key}"`, writeHttpMetadata: () => undefined };
  }

  async head(key: string): Promise<StoredObject | null> {
    const bytes = this.read("head", key);
    return bytes === undefined ? null : this.meta(key, bytes.byteLength);
  }

  async get(key: string, options?: { readonly range: ByteRange }): Promise<StoredBody | null> {
    const bytes = this.read("get", key);
    if (bytes === undefined) return null;
    const range = options?.range;
    if (range !== undefined && range.offset + range.length > bytes.byteLength) throw new Error("range out of bounds");
    const slice = range === undefined ? bytes : bytes.slice(range.offset, range.offset + range.length);
    this.bytesRead += slice.byteLength;
    return {
      ...this.meta(key, bytes.byteLength),
      body: new Response(slice).body ?? new ReadableStream(),
      text: async () => new TextDecoder().decode(slice),
    };
  }
}

/** Cloudflare's cache answers a single Range from a stored whole file with 206, as this does. */
export class FakeCache implements EdgeCache {
  readonly entries = new Map<string, Response>();
  async match(request: Request): Promise<Response | undefined> {
    const stored = this.entries.get(request.url)?.clone();
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("Range") ?? "");
    if (stored === undefined || range === null) return stored;
    const bytes = new Uint8Array(await stored.arrayBuffer());
    const start = Number(range[1]);
    const end = range[2] === "" || range[2] === undefined ? bytes.byteLength - 1 : Number(range[2]);
    const headers = new Headers(stored.headers);
    headers.set("Content-Range", `bytes ${start}-${end}/${bytes.byteLength}`);
    return new Response(bytes.slice(start, end + 1), { status: 206, headers });
  }
  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, new Response(await response.arrayBuffer(), response));
  }
}

class SqliteStatement implements Statement {
  private readonly sqlite: Sqlite;
  readonly sql: string;
  private readonly values: readonly unknown[];
  constructor(sqlite: Sqlite, sql: string, values: readonly unknown[] = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.values = values;
  }
  bind(...values: unknown[]): Statement {
    return new SqliteStatement(this.sqlite, this.sql, values);
  }
  private params(): (string | number | null)[] {
    return this.values.map((value) => (typeof value === "string" || typeof value === "number" ? value : null));
  }
  async all(): Promise<{ readonly results: readonly Record<string, unknown>[] }> {
    const rows: unknown[] = this.sqlite.query(this.sql).all(...this.params());
    return {
      results: rows.map((row) =>
        typeof row === "object" && row !== null ? Object.fromEntries(Object.entries(row)) : {},
      ),
    };
  }
  async run(): Promise<unknown> {
    return this.sqlite.query(this.sql).run(...this.params());
  }
}

/** D1 over bun:sqlite with the Worker's own migration applied. */
export function sqliteD1(): { readonly db: Database; readonly sqlite: Sqlite } {
  const sqlite = new Sqlite(":memory:");
  sqlite.exec(readFileSync(join(import.meta.dir, "..", "..", "migrations", "0001_downloads.sql"), "utf8"));
  const db: Database = {
    prepare: (sql) => new SqliteStatement(sqlite, sql),
    batch: async (statements) => Promise.all(statements.map((statement) => statement.all())),
  };
  return { db, sqlite };
}

export interface Harness {
  readonly bucket: FakeBucket;
  readonly cache: FakeCache;
  readonly points: DataPoint[];
  readonly env: Env;
  readonly ctx: RequestContext;
  readonly db: Database;
  readonly sqlite: Sqlite;
  settle(): Promise<unknown>;
}

export function harness(): Harness {
  const bucket = new FakeBucket();
  const cache = new FakeCache();
  const points: DataPoint[] = [];
  const pending: Promise<unknown>[] = [];
  const { db, sqlite } = sqliteD1();
  const env: Env = {
    RELEASES: bucket,
    DB: db,
    DOWNLOADS: { writeDataPoint: (written) => void points.push(written) },
    ANALYTICS_DATASET: "doriterm_downloads",
    ACCOUNT_ID: "account",
    ANALYTICS_TOKEN: "token",
  };
  // No test reaches the network: a test that needs GitHub's answer passes its own fetcher.
  const ctx: RequestContext = {
    env,
    cache,
    waitUntil: (promise) => void pending.push(promise),
    fetcher: async (url) => {
      throw new Error(`no network in the unit suite: ${url}`);
    },
  };
  return { bucket, cache, points, env, ctx, db, sqlite, settle: () => Promise.all(pending) };
}

/** Mirrors a version the way the release's mirror leaves it: every file, then `.complete`. */
export function mirror(bucket: FakeBucket, version: string, files: Readonly<Record<string, string>>): void {
  for (const [file, body] of Object.entries(files)) bucket.put(`releases/v${version}/${file}`, body);
  bucket.put(`releases/v${version}/.complete`, JSON.stringify({ version }));
}

export function point(
  bucket: FakeBucket,
  channel: "stable" | "beta",
  pointer: { version: string; previous?: string; rollout?: number; minimum?: string },
): void {
  bucket.put(
    `channels/${channel}.json`,
    JSON.stringify({ rollout: 100, publishedAt: "2026-11-12T03:10:00Z", ...pointer }),
  );
}

/** A feed as release.yml's merge-update-feed.ts leaves it (the 0.1.16 latest-mac.yml shape). */
export const macFeed = (version: string): string => `version: ${version}
files:
  - url: Doriterm-${version}-arm64-mac.zip
    sha512: aaaa
    size: 160051571
  - url: Doriterm-${version}-arm64.dmg
    sha512: bbbb
    size: 165502404
path: Doriterm-${version}-arm64-mac.zip
sha512: aaaa
releaseDate: 2026-11-09T10:58:27.969Z
`;
