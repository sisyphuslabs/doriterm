import { expect, test } from "bun:test";
import type { DataPoint } from "./bindings.ts";
import { route } from "./index.ts";
import { type Harness, harness, macFeed, mirror, point } from "./testing/fakes.ts";

const ORIGIN = "https://get.doriterm.com";
const get = (h: Harness, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Response> =>
  route(new Request(`${ORIGIN}${path}`, { method, headers }), h.ctx);

const DMG = "Doriterm-0.1.17-arm64.dmg";
const DMG_BYTES = "0123456789abcdef";

function released(): Harness {
  const h = harness();
  mirror(h.bucket, "0.1.16", { "Doriterm-0.1.16-arm64.dmg": "old", "install.sh": "#!/bin/sh\necho 0.1.16\n" });
  mirror(h.bucket, "0.1.17", {
    [DMG]: DMG_BYTES,
    "install.sh": "#!/bin/sh\necho 0.1.17\n",
    "latest-mac.yml": macFeed("0.1.17"),
    "doriface-host-linux-x64": "host-bytes",
  });
  point(h.bucket, "stable", { version: "0.1.17", previous: "0.1.16", rollout: 100, minimum: "0.1.10" });
  return h;
}

const fields = (p: DataPoint) => {
  const [kind, routeName, source, channel, version, asset, platform, country, qa] = p.blobs;
  return { kind, route: routeName, source, channel, version, asset, platform, country, qa };
};

test("/dl/<key> answers a no-store 302 to the stable version's file, and following it serves R2 and counts once", async () => {
  const h = released();
  const dl = await get(h, "/dl/mac-arm64.dmg");
  expect(dl.status).toBe(302);
  expect(dl.headers.get("Cache-Control")).toBe("no-store");
  const location = dl.headers.get("Location") ?? "";
  expect(location).toBe(`${ORIGIN}/v/0.1.17/${DMG}?via=dl&channel=stable`);
  expect(h.points).toEqual([]);

  const file = await route(new Request(location), h.ctx);
  expect(file.status).toBe(200);
  expect(file.headers.get("X-Doriterm-Source")).toBe("r2");
  expect(file.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  expect(await file.text()).toBe(DMG_BYTES);
  expect(h.points.map(fields)).toEqual([
    {
      kind: "desktop",
      route: "dl",
      source: "r2",
      channel: "stable",
      version: "0.1.17",
      asset: DMG,
      platform: "mac-arm64",
      country: "XX",
      qa: "",
    },
  ]);

  await h.settle();
  const again = await get(h, `/v/0.1.17/${DMG}`);
  expect(again.headers.get("X-Doriterm-Source")).toBe("cache");
  expect(await again.text()).toBe(DMG_BYTES);
  expect(h.points.map((p) => fields(p).route + "/" + fields(p).source)).toEqual(["dl/r2", "v/cache"]);
});

test("a Range request answers 206 with the bytes it names; If-Range on another ETag answers the whole file", async () => {
  const h = released();
  const head = await get(h, `/v/0.1.17/${DMG}`, { Range: "bytes=4-7" });
  expect(head.status).toBe(206);
  expect(head.headers.get("Content-Range")).toBe("bytes 4-7/16");
  expect(head.headers.get("Content-Length")).toBe("4");
  expect(await head.text()).toBe("4567");

  const suffix = await get(h, `/v/0.1.17/${DMG}`, { Range: "bytes=-3" });
  expect([suffix.status, await suffix.text()]).toEqual([206, "def"]);
  const open = await get(h, `/v/0.1.17/${DMG}`, { Range: "bytes=10-" });
  expect([open.status, open.headers.get("Content-Range"), await open.text()]).toEqual([
    206,
    "bytes 10-15/16",
    "abcdef",
  ]);
  const past = await get(h, `/v/0.1.17/${DMG}`, { Range: "bytes=16-" });
  expect([past.status, past.headers.get("Content-Range")]).toEqual([416, "bytes */16"]);
  const stale = await get(h, `/v/0.1.17/${DMG}`, { Range: "bytes=4-7", "If-Range": '"other"' });
  expect([stale.status, await stale.text()]).toEqual([200, DMG_BYTES]);
  await h.settle();
  const multi = await get(h, `/v/0.1.17/${DMG}`, { Range: "bytes=0-1,4-5" });
  expect([multi.status, multi.headers.get("Content-Type")?.split(";")[0]]).toEqual([206, "multipart/byteranges"]);

  // Only the ranges from byte 0 count: a manager's later ranges, the 416 and the HEAD below do not. The whole-file
  // answers above filled the edge cache, which now answers the range itself.
  await h.settle();
  const fromZero = await get(h, `/v/0.1.17/${DMG}`, { Range: "bytes=0-3" });
  expect([fromZero.status, fromZero.headers.get("X-Doriterm-Source"), await fromZero.text()]).toEqual([
    206,
    "cache",
    "0123",
  ]);
  const headOnly = await get(h, `/v/0.1.17/${DMG}`, {}, "HEAD");
  expect([headOnly.status, headOnly.headers.get("Content-Length"), await headOnly.text()]).toEqual([200, "16", ""]);
  // The several ranges from byte 0 count once, from R2 (#2228); the single range from byte 0 from the cache.
  expect(h.points.map((p) => p.blobs[2])).toEqual(["r2", "cache"]);
});

test("a version without .complete, a missing object and an R2 failure each redirect to GitHub Releases", async () => {
  const h = released();
  h.bucket.put("releases/v0.1.18/Doriterm-0.1.18-arm64.dmg", "partial");
  const partial = await get(h, "/v/0.1.18/Doriterm-0.1.18-arm64.dmg");
  expect(partial.status).toBe(302);
  expect(partial.headers.get("Location")).toBe(
    "https://github.com/sisyphuslabs/doriterm/releases/download/v0.1.18/Doriterm-0.1.18-arm64.dmg",
  );
  expect(partial.headers.get("X-Doriterm-Fallback")).toBe("version-not-mirrored");
  expect((await get(h, "/v/0.1.17/Doriterm-0.1.17-x64.dmg")).headers.get("X-Doriterm-Fallback")).toBe("object-missing");
  h.bucket.failWith = new Error("R2 down");
  const down = await get(h, `/v/0.1.17/${DMG}`);
  expect([down.status, down.headers.get("X-Doriterm-Fallback")]).toEqual([302, "r2-error"]);
  expect(h.points.map((p) => fields(p).source)).toEqual(["github", "github", "github"]);
});

test("markers, climbs and unknown versions are never read from the bucket", async () => {
  const h = released();
  const paths = ["/v/0.1.17/.complete", "/v/0.1.17/..", "/v/latest/install.sh", "/v/0.1.17/a%2Fb"];
  const statuses = await Promise.all(paths.map(async (path) => [path, (await get(h, path)).status]));
  expect(statuses).toEqual(paths.map((path) => [path, 404]));
  expect(h.bucket.reads).toEqual([]);
  expect((await get(h, "/v/0.1.17/install.sh", {}, "POST")).status).toBe(405);
});

test("the desktop feed names the stable version's files under the channel, with the rollout and the floor", async () => {
  const h = released();
  point(h.bucket, "stable", { version: "0.1.17", previous: "0.1.16", rollout: 25, minimum: "0.1.10" });
  const feed = await get(h, "/desktop/stable/latest-mac.yml");
  expect(feed.status).toBe(200);
  expect(feed.headers.get("Cache-Control")).toBe("public, max-age=60");
  const body = await feed.text();
  const parsed = Bun.YAML.parse(body) as { files: { url: string }[]; path: string; stagingPercentage: number };
  expect(parsed.files.map((f) => f.url)).toEqual([
    "0.1.17/Doriterm-0.1.17-arm64-mac.zip",
    "0.1.17/Doriterm-0.1.17-arm64.dmg",
  ]);
  expect(parsed.path).toBe("0.1.17/Doriterm-0.1.17-arm64-mac.zip");
  expect(parsed).toMatchObject({ version: "0.1.17", stagingPercentage: 25, minimumVersion: "0.1.10", sha512: "aaaa" });
  expect(fields(h.points[0] ?? { blobs: [], doubles: [], indexes: [] })).toMatchObject({
    kind: "check",
    route: "desktop-update",
    channel: "stable",
    version: "0.1.17",
    asset: "latest-mac.yml",
    platform: "mac",
  });

  const update = await route(new Request(new URL(parsed.files[1]?.url ?? "", `${ORIGIN}/desktop/stable/`).href), h.ctx);
  expect([update.status, await update.text()]).toEqual([200, DMG_BYTES]);
  expect(fields(h.points[1] ?? { blobs: [], doubles: [], indexes: [] })).toMatchObject({
    kind: "desktop",
    route: "desktop-update",
    channel: "stable",
  });
  expect((await get(h, "/desktop/stable/latest.yml")).status).toBe(404);
  expect((await get(h, "/desktop/nightly/latest-mac.yml")).status).toBe(404);
  expect((await get(h, "/desktop/stable/app.yml")).status).toBe(404);
});

test("a stored feed for another version, or one that names a file outside the release, is refused", async () => {
  const h = released();
  h.bucket.put("releases/v0.1.17/latest-mac.yml", macFeed("0.1.16"));
  expect((await get(h, "/desktop/stable/latest-mac.yml")).status).toBe(502);
  h.bucket.put(
    "releases/v0.1.17/latest-mac.yml",
    macFeed("0.1.17").replace("url: Doriterm", "url: https://x/Doriterm"),
  );
  expect((await get(h, "/desktop/stable/latest-mac.yml")).status).toBe(502);
});

test("the host manifest is served byte for byte while it names the offered version, and 503 once the pointer moves", async () => {
  const h = released();
  const manifest = JSON.stringify({ version: "0.1.17", rollout: 100, minimum: "0.1.10", targets: {} });
  h.bucket.put("channels/stable.host-manifest.json", manifest);
  h.bucket.put("channels/stable.host-manifest.json.sig", "c2lnbmF0dXJl\n");
  const served = await get(h, "/host/stable/manifest.json");
  expect([served.status, await served.text()]).toEqual([200, manifest]);
  expect(await (await get(h, "/host/stable/manifest.json.sig")).text()).toBe("c2lnbmF0dXJl\n");
  expect(h.points.map((p) => fields(p).kind + "/" + fields(p).route)).toEqual(["check/host-update"]);
  const binary = await get(h, "/host/stable/0.1.17/doriface-host-linux-x64");
  expect([binary.status, await binary.text()]).toEqual([200, "host-bytes"]);
  expect(fields(h.points[1] ?? { blobs: [], doubles: [], indexes: [] })).toMatchObject({
    kind: "host",
    route: "host-update",
    platform: "linux-x64",
  });

  point(h.bucket, "stable", { version: "0.1.16" });
  expect((await get(h, "/host/stable/manifest.json")).status).toBe(503);
  expect((await get(h, "/host/stable/manifest.json.sig")).status).toBe(503);
  expect((await get(h, "/host/stable/manifest.yml")).status).toBe(404);
});

test("a rollback names the previous version in the feed, the manifest and /dl on the next request", async () => {
  const h = released();
  mirror(h.bucket, "0.1.16", { "latest-mac.yml": macFeed("0.1.16"), "Doriterm-0.1.16-arm64.dmg": "old" });
  expect((await get(h, "/dl/mac-arm64.dmg")).headers.get("Location")).toContain("/v/0.1.17/");
  point(h.bucket, "stable", { version: "0.1.16", previous: "0.1.15" });
  expect((await get(h, "/dl/mac-arm64.dmg")).headers.get("Location")).toContain("/v/0.1.16/Doriterm-0.1.16-arm64.dmg");
  expect(await (await get(h, "/desktop/stable/latest-mac.yml")).text()).toContain("version: 0.1.16\n");
  // A yank without a rollback does the same: the yanked version is never named again, yet its files stay served.
  point(h.bucket, "stable", { version: "0.1.17", previous: "0.1.16" });
  h.bucket.put("releases/v0.1.17/.yanked", "{}");
  expect((await get(h, "/dl/mac-arm64.dmg")).headers.get("Location")).toContain("/v/0.1.16/");
  expect((await get(h, `/v/0.1.17/${DMG}`)).status).toBe(200);
});

test("/ gives curl the stable install.sh and a browser the download page; before any mirror both go to GitHub", async () => {
  const h = released();
  const curl = await get(h, "/", { "User-Agent": "curl/8.7.1" });
  expect([curl.status, curl.headers.get("Cache-Control"), await curl.text()]).toEqual([
    200,
    "public, max-age=60",
    "#!/bin/sh\necho 0.1.17\n",
  ]);
  expect(curl.headers.get("Content-Disposition")).toBeNull();
  expect(await (await get(h, "/install.sh")).text()).toContain("0.1.17");
  const page = await get(h, "/", { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
  const html = await page.text();
  expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(html).toContain("Download Doriterm 0.1.17");
  expect(html.indexOf("<h2>Windows</h2>")).toBeLessThan(html.indexOf("<h2>macOS</h2>"));
  for (const key of ["win-x64.exe", "win-arm64.exe", "mac-arm64.dmg", "linux-arm64.deb"])
    expect(html).toContain(`/dl/${key}`);

  const empty = harness();
  const first = await get(empty, "/", { "User-Agent": "curl/8.7.1" });
  expect(first.headers.get("Location")).toBe(
    "https://github.com/sisyphuslabs/doriterm/releases/latest/download/install.sh",
  );
  expect((await get(empty, "/dl/host-mac-arm64")).headers.get("Location")).toBe(
    "https://github.com/sisyphuslabs/doriterm/releases/latest/download/doriface-host-mac-arm64",
  );
  expect((await get(empty, "/dl/mac-arm64.dmg")).headers.get("Location")).toBe(
    "https://github.com/sisyphuslabs/doriterm/releases/latest",
  );
  expect((await get(empty, "/dl/nope")).status).toBe(404);
  // Before any mirror the feed comes from GitHub (github-feed.test.ts); here GitHub does not answer.
  expect((await get(empty, "/desktop/stable/latest-mac.yml")).status).toBe(503);
  expect(await (await get(empty, "/healthz")).text()).toBe("ok\n");
});

test("a CI smoke download is flagged qa and the country comes from Cloudflare's metadata", async () => {
  const h = released();
  const request = new Request(`${ORIGIN}/v/0.1.17/install.sh`, {
    headers: { "User-Agent": "curl doriterm-install-qa" },
  });
  Object.defineProperty(request, "cf", { value: { country: "KR" } });
  await route(request, h.ctx);
  expect(fields(h.points[0] ?? { blobs: [], doubles: [], indexes: [] })).toMatchObject({ country: "KR", qa: "qa" });
});
