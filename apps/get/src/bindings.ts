/**
 * The parts of the Workers runtime this Worker uses, declared here rather than taken from @cloudflare/workers-types, so
 * the unit suite runs the real routes against in-memory fakes with no workerd or wrangler. The runtime's R2, D1,
 * Analytics Engine and cache objects satisfy these shapes.
 */

/** An R2 object's metadata, as `head` answers it. */
export interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

/** An R2 object with its body, as `get` answers it. */
export interface StoredBody extends StoredObject {
  readonly body: ReadableStream<Uint8Array>;
  text(): Promise<string>;
}

export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

export interface ReleaseBucket {
  head(key: string): Promise<StoredObject | null>;
  get(key: string, options?: { readonly range: ByteRange }): Promise<StoredBody | null>;
}

export interface Statement {
  bind(...values: unknown[]): Statement;
  all(): Promise<{ readonly results: readonly Record<string, unknown>[] }>;
  run(): Promise<unknown>;
}

export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<readonly { readonly results?: readonly Record<string, unknown>[] }[]>;
}

export interface DataPoint {
  readonly blobs: string[];
  readonly doubles: number[];
  readonly indexes: string[];
}

export interface DataPointWriter {
  writeDataPoint(point: DataPoint): void;
}

export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface Env {
  readonly RELEASES: ReleaseBucket;
  readonly DB: Database;
  readonly DOWNLOADS: DataPointWriter;
  /** The Analytics Engine dataset DOWNLOADS writes to, which the hourly rollup reads back. */
  readonly ANALYTICS_DATASET: string;
  /** Given at deploy (`wrangler deploy --var`), never written in wrangler.jsonc; the rollup's SQL API needs it. */
  readonly ACCOUNT_ID?: string;
  /** Worker secret: a read-only Account Analytics token, used only by the hourly rollup. */
  readonly ANALYTICS_TOKEN?: string;
}

export interface RequestContext {
  readonly env: Env;
  readonly cache: EdgeCache;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /** An outbound fetch (GitHub's release feed); the runtime's fetch when absent, a fake in the unit suite. */
  readonly fetcher?: (url: string) => Promise<Response>;
}
