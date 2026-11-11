import { expect, test } from "bun:test";
import { join } from "node:path";
import type { RequestContext } from "./bindings.ts";
import { githubFeed } from "./github-feed.ts";
import { route } from "./index.ts";
import { harness, macFeed, mirror, point } from "./testing/fakes.ts";

const RELEASES = "https://github.com/sisyphuslabs/doriterm/releases";

function withGitHub(feeds: Readonly<Record<string, string>>) {
  const h = harness();
  const asked: string[] = [];
  const ctx: RequestContext = {
    ...h.ctx,
    fetcher: async (url) => {
      asked.push(url);
      const body = feeds[url.slice(url.lastIndexOf("/") + 1)];
      return body === undefined ? new Response("Not Found", { status: 404 }) : new Response(body);
    },
  };
  const get = (path: string) => route(new Request(`https://get.doriterm.com${path}`), ctx);
  return { ...h, ctx, asked, get };
}

test("before any mirror the desktop feed is GitHub's latest, with absolute download URLs electron-updater follows", async () => {
  const g = withGitHub({ "latest-mac.yml": macFeed("0.1.18") });
  const response = await g.get("/desktop/stable/latest-mac.yml");
  expect([response.status, response.headers.get("X-Doriterm-Source")]).toEqual([200, "github"]);
  const body = await response.text();
  expect(g.asked).toEqual([`${RELEASES}/latest/download/latest-mac.yml`]);
  expect(body).not.toContain("stagingPercentage");
  expect(body).toContain(`version: 0.1.18\n`);
  expect(body.match(/(?:url|path): \S+/g)).toEqual([
    `url: ${RELEASES}/download/v0.1.18/Doriterm-0.1.18-arm64-mac.zip`,
    `url: ${RELEASES}/download/v0.1.18/Doriterm-0.1.18-arm64.dmg`,
    `path: ${RELEASES}/download/v0.1.18/Doriterm-0.1.18-arm64-mac.zip`,
  ]);
  expect(g.points.map((p) => p.blobs.slice(0, 5))).toEqual([["check", "desktop-update", "github", "stable", "0.1.18"]]);

  // Beta follows it too while neither channel has a pointer; the edge cache answers the second read.
  await g.settle();
  expect(await (await g.get("/desktop/beta/latest-mac.yml")).text()).toBe(body);
  expect(g.asked.length).toBe(1);
});

test("once a channel has a pointer, or every version it named is yanked, GitHub is never consulted", async () => {
  const g = withGitHub({ "latest-mac.yml": macFeed("0.1.18") });
  mirror(g.bucket, "0.1.17", { "latest-mac.yml": macFeed("0.1.17") });
  point(g.bucket, "stable", { version: "0.1.17" });
  expect(await (await g.get("/desktop/stable/latest-mac.yml")).text()).toContain("version: 0.1.17\n");
  g.bucket.put("releases/v0.1.17/.yanked", "{}");
  expect((await g.get("/desktop/stable/latest-mac.yml")).status).toBe(404);
  expect((await g.get("/desktop/beta/latest-mac.yml")).status).toBe(404);
  expect(g.asked).toEqual([]);
});

test("a feed read that R2 fails, all of it or one object, answers GitHub's latest feed, not 503 (#2123)", async () => {
  const fails = ["all", "releases/v0.1.17/.yanked", "releases/v0.1.17/latest-mac.yml"];
  const answers = await Promise.all(
    fails.map(async (fail) => {
      const g = withGitHub({ "latest-mac.yml": macFeed("0.1.18") });
      mirror(g.bucket, "0.1.17", { "latest-mac.yml": macFeed("0.1.17") });
      point(g.bucket, "stable", { version: "0.1.17" });
      if (fail === "all") g.bucket.failWith = new Error("R2 down");
      else g.bucket.failKey = fail;
      const response = await g.get("/desktop/stable/latest-mac.yml");
      const offersDmg = (await response.text()).includes(
        `url: ${RELEASES}/download/v0.1.18/Doriterm-0.1.18-arm64.dmg\n`,
      );
      return [fail, response.status, response.headers.get("X-Doriterm-Source"), offersDmg];
    }),
  );
  expect(answers).toEqual(fails.map((fail) => [fail, 200, "github", true]));
});

test("a GitHub feed that names no single version or a file outside the release is refused, not passed on", async () => {
  expect(githubFeed("files:\n  - url: a.zip\n")).toBeNull();
  expect(githubFeed("version: 0.1.18\nversion: 0.1.19\npath: a.zip\n")).toBeNull();
  expect(githubFeed("version: 0.1.18\npath: https://evil.example/a.zip\n")).toBeNull();
  expect(githubFeed("version: 0.1.18\npath: ../a.zip\n")).toBeNull();
  // Only electron-builder's own line shapes are accepted, so no other YAML form can carry a URL (#2109 review).
  for (const hostile of [
    "version: 0.1.18\nfiles: [{url: 'https://evil.example/a.zip', sha512: a}]\npath: a.zip\n",
    "version: 0.1.18\nfiles:\n  - url:\thttps://evil.example/a.zip\npath: a.zip\n",
    'version: 0.1.18\nfiles:\n  - "url": https://evil.example/a.zip\npath: a.zip\n',
    "version: 0.1.18\nfiles: oops\npath: a.zip\n",
    "version: 0.1.18\nreleaseNotes: |\n  url: https://evil.example/a.zip\npath: a.zip\n",
  ]) {
    expect([hostile, githubFeed(hostile)]).toEqual([hostile, null]);
  }
  expect(githubFeed("version: 0.1.18\npath: a.zip\nstagingPercentage: 5\n")).toBe(
    `version: 0.1.18\npath: ${RELEASES}/download/v0.1.18/a.zip\n`,
  );
  const g = withGitHub({});
  expect((await g.get("/desktop/stable/latest-mac.yml")).status).toBe(502);
  const bad = withGitHub({ "latest-mac.yml": "<html>rate limited</html>" });
  expect((await bad.get("/desktop/stable/latest-mac.yml")).status).toBe(502);
});

// v0.1.16's latest-linux.yml exactly as GitHub Releases serves it.
const V0_1_16_LINUX =
  "version: 0.1.16\nfiles:\n  - url: Doriterm-0.1.16-x86_64.AppImage\n    sha512: rQCNuqLIVRwhUYhJNVt39FikqAH4N1cOLdw2Xs3G7gmfnIWEcIU7YYRgLy3hF1LVk+SZzmBE5utPdn/ZkjkK/w==\n    size: 169689710\n    blockMapSize: 178290\n  - url: Doriterm_0.1.16_amd64.deb\n    sha512: zJi/1foIZ/bkl6sMZpbz5Cz73O9+l0C1RVoAltHdyi1T71D8EjX5bFKkXy4eklzHql9FnGFtP5zrM+lPIuu9xg==\n    size: 146340548\npath: Doriterm-0.1.16-x86_64.AppImage\nsha512: rQCNuqLIVRwhUYhJNVt39FikqAH4N1cOLdw2Xs3G7gmfnIWEcIU7YYRgLy3hF1LVk+SZzmBE5utPdn/ZkjkK/w==\nreleaseDate: 2026-11-09T11:00:39.288Z\n";

test("a feed as release.yml publishes it is accepted whole, every file pointed at its GitHub download", () => {
  const composed = githubFeed(V0_1_16_LINUX);
  expect(composed?.match(/(?:url|path): \S+/g)).toEqual([
    `url: ${RELEASES}/download/v0.1.16/Doriterm-0.1.16-x86_64.AppImage`,
    `url: ${RELEASES}/download/v0.1.16/Doriterm_0.1.16_amd64.deb`,
    `path: ${RELEASES}/download/v0.1.16/Doriterm-0.1.16-x86_64.AppImage`,
  ]);
  expect(composed).toContain("blockMapSize: 178290\n");
  expect(composed).toContain("releaseDate: 2026-11-09T11:00:39.288Z\n");
});

test("no file the Worker runs uses a Bun API, which the Workers runtime does not have", async () => {
  // Everything wrangler bundles from the entry point, at any depth (#1981): a browser build refuses an import of "bun"
  // or "bun:*", and the bundle must not name the Bun global.
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "index.ts")], target: "browser", throw: false });
  expect(built.logs.map(String)).toEqual([]);
  const code = (await built.outputs[0]?.text()) ?? "";
  expect(code.length).toBeGreaterThan(10_000);
  expect(code.match(/\bBun\b/g) ?? []).toEqual([]);
});
