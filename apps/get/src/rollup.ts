import type { Database, Env } from "./bindings.ts";

const ROLLUP_DAYS = 7;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_DATASET = /^[A-Za-z0-9_]+$/;
/** The SQL API call, a parameter so the unit suite answers it without the network. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const DIMENSIONS = ["kind", "route", "source", "channel", "version", "asset", "platform"] as const;

export type RollupRow = { readonly day: string; readonly count: number } & {
  readonly [K in (typeof DIMENSIONS)[number]]: string;
};

export class RollupError extends Error {
  override readonly name = "RollupError";
}

/**
 * The last seven UTC days, each from its start, without the rows a CI smoke run tagged `qa`. Analytics Engine samples a
 * busy dataset; SUM(_sample_interval) restores the count. Today's partial day is replaced by every later run.
 */
export function rollupQuery(dataset: string, days: number = ROLLUP_DAYS): string {
  if (!SAFE_DATASET.test(dataset)) throw new RollupError(`invalid dataset name ${dataset}`);
  return `SELECT formatDateTime(timestamp, '%Y-%m-%d') AS day, blob1 AS kind, blob2 AS route, blob3 AS source, blob4 AS channel, blob5 AS version, blob6 AS asset, blob7 AS platform, SUM(_sample_interval * double1) AS count
FROM ${dataset}
WHERE timestamp >= toStartOfDay(NOW() - INTERVAL '${days - 1}' DAY) AND blob9 != 'qa'
GROUP BY day, kind, route, source, channel, version, asset, platform
FORMAT JSON`;
}

export function parseRollupRows(payload: unknown): RollupRow[] {
  const data = typeof payload === "object" && payload !== null ? Reflect.get(payload, "data") : undefined;
  if (!Array.isArray(data)) throw new RollupError("Analytics Engine response has no data array");
  return data.map((row: unknown): RollupRow => {
    const field = (name: string): unknown =>
      typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined;
    const textOf = (name: string): string => {
      const value = field(name);
      if (typeof value !== "string") throw new RollupError(`Analytics Engine row has no ${name}`);
      return value;
    };
    const day = field("day");
    const count = Number(field("count"));
    if (typeof day !== "string" || !DAY.test(day)) throw new RollupError("Analytics Engine row has no day");
    if (!Number.isFinite(count) || count < 0) throw new RollupError("Analytics Engine row has no count");
    return {
      day,
      count: Math.round(count),
      kind: textOf("kind"),
      route: textOf("route"),
      source: textOf("source"),
      channel: textOf("channel"),
      version: textOf("version"),
      asset: textOf("asset"),
      platform: textOf("platform"),
    };
  });
}

export async function queryAnalytics(env: Env, fetcher: Fetcher = fetch): Promise<RollupRow[]> {
  if (!env.ANALYTICS_TOKEN) throw new RollupError("ANALYTICS_TOKEN is not configured");
  if (!env.ACCOUNT_ID) throw new RollupError("ACCOUNT_ID is not configured");
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.ANALYTICS_TOKEN}` },
      body: rollupQuery(env.ANALYTICS_DATASET),
    },
  );
  if (!response.ok) throw new RollupError(`Analytics Engine SQL returned ${response.status}`);
  return parseRollupRows(await response.json());
}

export async function storeRollup(db: Database, rows: readonly RollupRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const upsert = db.prepare(
    `INSERT INTO downloads_daily (day, kind, route, source, channel, version, asset, platform, count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (day, kind, route, source, channel, version, asset, platform) DO UPDATE SET count = excluded.count`,
  );
  await db.batch(
    rows.map((row) =>
      upsert.bind(
        row.day,
        row.kind,
        row.route,
        row.source,
        row.channel,
        row.version,
        row.asset,
        row.platform,
        row.count,
      ),
    ),
  );
  return rows.length;
}

export async function runDownloadsRollup(env: Env, fetcher: Fetcher = fetch): Promise<number> {
  return storeRollup(env.DB, await queryAnalytics(env, fetcher));
}
