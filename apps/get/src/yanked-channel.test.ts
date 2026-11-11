import { expect, test } from "bun:test";
import { route } from "./index.ts";
import { type Harness, harness, mirror, point } from "./testing/fakes.ts";

const get = (h: Harness, path: string, headers: Record<string, string> = {}): Promise<Response> =>
  route(new Request(`https://get.doriterm.com${path}`, { headers }), h.ctx);

const CURL = { "User-Agent": "curl/8.7.1" };
const PATHS = ["/dl/mac-arm64.dmg", "/dl/host-mac-arm64", "/dl/beta/mac-arm64.dmg", "/install.sh", "/beta/install.sh"];

function allYanked(previous: string | undefined): Harness {
  const h = harness();
  mirror(h.bucket, "0.1.17", { "Doriterm-0.1.17-arm64.dmg": "new", "install.sh": "#!/bin/sh\n" });
  point(h.bucket, "stable", previous === undefined ? { version: "0.1.17" } : { version: "0.1.17", previous });
  h.bucket.put("releases/v0.1.17/.yanked", "{}");
  if (previous !== undefined) h.bucket.put(`releases/v${previous}/.yanked`, "{}");
  return h;
}

test("a channel whose every version is yanked answers 503, never GitHub's latest release, which can be the yank (#1981 item 4)", async () => {
  const cases = ["0.1.16", undefined].flatMap((previous) => {
    const h = allYanked(previous);
    return [...PATHS, "/"].map((path) => ({ previous, path, h }));
  });
  const answers = await Promise.all(
    cases.map(async ({ previous, path, h }) => {
      const response = await get(h, path, CURL);
      return [previous, path, response.status, response.headers.get("Location")];
    }),
  );
  expect(answers).toEqual(cases.map(({ previous, path }) => [previous, path, 503, null]));
});

test("an R2 read that fails, even one of several, sends /dl and the installer to GitHub, not 503 (#2213 review)", async () => {
  const h = harness();
  mirror(h.bucket, "0.1.17", { "install.sh": "#!/bin/sh\n" });
  point(h.bucket, "stable", { version: "0.1.17" });
  h.bucket.failKey = "releases/v0.1.17/.yanked";
  const LATEST = "https://github.com/sisyphuslabs/doriterm/releases/latest";
  const answers = await Promise.all(
    ["/install.sh", "/dl/host-mac-arm64", "/"].map(async (path) => {
      const response = await get(h, path, CURL);
      return [path, response.status, response.headers.get("Location")];
    }),
  );
  expect(answers).toEqual([
    ["/install.sh", 302, `${LATEST}/download/install.sh`],
    ["/dl/host-mac-arm64", 302, `${LATEST}/download/doriface-host-mac-arm64`],
    ["/", 302, `${LATEST}/download/install.sh`],
  ]);
});

test("/ varies on User-Agent, so no shared cache hands a browser the installer or curl the page (#1981 item 1)", async () => {
  const h = harness();
  mirror(h.bucket, "0.1.17", { "install.sh": "#!/bin/sh\n" });
  point(h.bucket, "stable", { version: "0.1.17" });
  const browser = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)" };
  const empty = harness();
  const cases = [
    { state: "mirrored", h, headers: CURL },
    { state: "mirrored", h, headers: browser },
    { state: "never mirrored", h: empty, headers: CURL },
    { state: "never mirrored", h: empty, headers: browser },
  ];
  const varies = await Promise.all(
    cases.map(async ({ state, h: at, headers }) => [state, headers, (await get(at, "/", headers)).headers.get("Vary")]),
  );
  expect(varies).toEqual(cases.map(({ state, headers }) => [state, headers, "User-Agent"]));
});
