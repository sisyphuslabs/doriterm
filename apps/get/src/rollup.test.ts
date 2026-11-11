import { expect, test } from "bun:test";
import { parseRollupRows, RollupError, rollupQuery, runDownloadsRollup } from "./rollup.ts";
import { route } from "./index.ts";
import { harness } from "./testing/fakes.ts";

const row = (day: string, kind: string, routeName: string, count: number) => ({
  day,
  kind,
  route: routeName,
  source: "r2",
  channel: "stable",
  version: "0.1.17",
  asset: "a",
  platform: "mac-arm64",
  count: String(count),
});

test("the rollup reads whole UTC days back to six days ago, groups by every stored field and leaves qa rows out", () => {
  const sql = rollupQuery("doriterm_downloads");
  expect(sql).toContain("toStartOfDay(NOW() - INTERVAL '6' DAY)");
  expect(sql).toContain("blob9 != 'qa'");
  expect(sql).toContain("GROUP BY day, kind, route, source, channel, version, asset, platform");
  expect(sql).toContain("SUM(_sample_interval * double1)");
  expect(() => rollupQuery("x; DROP TABLE y")).toThrow(RollupError);
  expect(() => parseRollupRows({ data: [{ ...row("2026-11-12", "host", "v", 1), day: "today" }] })).toThrow(
    RollupError,
  );
  expect(() => parseRollupRows({ meta: [] })).toThrow(RollupError);
});

test("an hourly run upserts each day, so a later run replaces a partial day, and /stats/downloads reads D1", async () => {
  const h = harness();
  const calls: { url: string; auth: string | null; body: string }[] = [];
  const answer = (rows: unknown[]) => async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("Authorization"), body: String(init.body) });
    return Response.json({ data: rows });
  };
  await runDownloadsRollup(
    h.env,
    answer([row("2026-11-12", "desktop", "dl", 2), row("2026-11-12", "check", "desktop-update", 9)]),
  );
  await runDownloadsRollup(
    h.env,
    answer([
      row("2026-11-12", "desktop", "dl", 3),
      row("2026-11-12", "desktop", "desktop-update", 1),
      row("2026-11-12", "host", "host-update", 1),
      row("2026-11-12", "check", "desktop-update", 12),
    ]),
  );
  expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/account/analytics_engine/sql");
  expect(calls[0]?.auth).toBe("Bearer token");
  expect(h.sqlite.query("SELECT COUNT(*) AS n FROM downloads_daily").get()).toEqual({ n: 4 });

  const response = await route(new Request("https://get.doriterm.com/stats/downloads"), h.ctx);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
  const stats: unknown = await response.json();
  expect(stats).toMatchObject({
    downloads: 5,
    byKind: { desktop: 4, host: 1 },
    checks: 12,
    rolledUpThrough: "2026-11-12",
  });
  await h.settle();
  expect(h.cache.entries.has("https://get.doriterm.com/stats/downloads")).toBe(true);
});

test("a rollup without its token or account id fails before it queries", async () => {
  const h = harness();
  let fetched = false;
  const fetcher = async () => {
    fetched = true;
    return Response.json({ data: [] });
  };
  await expect(runDownloadsRollup({ ...h.env, ANALYTICS_TOKEN: "" }, fetcher)).rejects.toThrow("ANALYTICS_TOKEN");
  await expect(runDownloadsRollup({ ...h.env, ACCOUNT_ID: "" }, fetcher)).rejects.toThrow("ACCOUNT_ID");
  expect(fetched).toBe(false);
});
