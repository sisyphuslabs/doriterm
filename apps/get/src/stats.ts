import type { Database, RequestContext } from "./bindings.ts";

const STATS_TTL_SECONDS = 300;

export interface DayRow {
  readonly day: string;
  readonly kind: string;
  readonly route: string;
  readonly channel: string;
  readonly version: string;
  readonly platform: string;
  readonly count: number;
}

/** `/stats/downloads`: everything the D1 rollup holds; `check` rows are update checks, not downloads. */
export interface DownloadStats {
  readonly downloads: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly checks: number;
  readonly rolledUpThrough: string | null;
  readonly last30Days: readonly DayRow[];
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number => (typeof value === "number" ? value : 0);

export async function readDownloadStats(db: Database): Promise<DownloadStats> {
  const [kinds, days, latest] = await db.batch([
    db.prepare("SELECT kind, SUM(count) AS total FROM downloads_daily GROUP BY kind"),
    db.prepare(
      `SELECT day, kind, route, channel, version, platform, SUM(count) AS count FROM downloads_daily
       WHERE day >= strftime('%Y-%m-%d', 'now', '-29 days')
       GROUP BY day, kind, route, channel, version, platform ORDER BY day, kind, route, channel, version, platform`,
    ),
    db.prepare("SELECT MAX(day) AS day FROM downloads_daily"),
  ]);
  const byKind: Record<string, number> = {};
  for (const row of kinds?.results ?? []) byKind[str(row["kind"])] = num(row["total"]);
  const { check = 0, ...downloadKinds } = byKind;
  const day = latest?.results?.[0]?.["day"];
  return {
    downloads: Object.values(downloadKinds).reduce((sum, total) => sum + total, 0),
    byKind: downloadKinds,
    checks: check,
    rolledUpThrough: typeof day === "string" ? day : null,
    last30Days: (days?.results ?? []).map((row) => ({
      day: str(row["day"]),
      kind: str(row["kind"]),
      route: str(row["route"]),
      channel: str(row["channel"]),
      version: str(row["version"]),
      platform: str(row["platform"]),
      count: num(row["count"]),
    })),
  };
}

export async function serveDownloadStats(request: Request, ctx: RequestContext): Promise<Response> {
  const cacheKey = new Request(`${new URL(request.url).origin}/stats/downloads`);
  const cached = await ctx.cache.match(cacheKey);
  const headers = { "Cache-Control": `public, max-age=${STATS_TTL_SECONDS}`, "Access-Control-Allow-Origin": "*" };
  let response = cached;
  if (response === undefined) {
    const body = JSON.stringify(await readDownloadStats(ctx.env.DB));
    const fresh = { headers: { ...headers, "Content-Type": "application/json" } };
    ctx.waitUntil(ctx.cache.put(cacheKey, new Response(body, fresh)));
    response = new Response(body, fresh);
  }
  return request.method === "HEAD" ? new Response(null, { headers: response.headers }) : response;
}
