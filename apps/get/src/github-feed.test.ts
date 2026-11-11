import { expect, test } from "bun:test";
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

test("a GitHub feed that names no single version or a file outside the release is refused, not passed on", async () => {
  expect(githubFeed("files:\n  - url: a.zip\n")).toBeNull();
  expect(githubFeed("version: 0.1.18\nversion: 0.1.19\npath: a.zip\n")).toBeNull();
  expect(githubFeed("version: 0.1.18\npath: https://evil.example/a.zip\n")).toBeNull();
  expect(githubFeed("version: 0.1.18\npath: ../a.zip\n")).toBeNull();
  // Shapes the line rewrite does not see are caught when the result is read back as YAML (#2109 review).
  for (const hostile of [
    "version: 0.1.18\nfiles: [{url: 'https://evil.example/a.zip', sha512: a}]\npath: a.zip\n",
    "version: 0.1.18\nfiles:\n  - url:\thttps://evil.example/a.zip\npath: a.zip\n",
    'version: 0.1.18\nfiles:\n  - "url": https://evil.example/a.zip\npath: a.zip\n',
    "version: 0.1.18\nfiles: oops\npath: a.zip\n",
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
