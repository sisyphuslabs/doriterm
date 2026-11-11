-- Daily counts rolled up from the Analytics Engine dataset by the hourly cron (#1969). The country and the qa flag stay in
-- Analytics Engine: the rollup leaves qa rows out and keeps no country.
CREATE TABLE IF NOT EXISTS downloads_daily (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  route TEXT NOT NULL,
  source TEXT NOT NULL,
  channel TEXT NOT NULL,
  version TEXT NOT NULL,
  asset TEXT NOT NULL,
  platform TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, kind, route, source, channel, version, asset, platform)
);
