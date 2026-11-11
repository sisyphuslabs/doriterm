import { expect, test } from "bun:test";
import { composeFeed } from "./feeds.ts";
import { githubFeed } from "./github-feed.ts";
import { macFeed } from "./testing/fakes.ts";

const RESOLVED = { channel: "stable", version: "0.1.18", rollout: 100 } as const;
const NOTES = "releaseNotes: |\n  url: https://evil.example/a.zip\n  - url: notes.zip\n  path: ../a.zip\n";

test("a url or path line inside releaseNotes is notes text, neither rewritten nor refused (#1981 item 3)", () => {
  const composed = composeFeed(`${macFeed("0.1.18")}${NOTES}`, RESOLVED);
  expect(composed).toContain(NOTES);
  expect(composed?.match(/^.*0\.1\.18\/\S+$/gm)).toEqual([
    "  - url: 0.1.18/Doriterm-0.1.18-arm64-mac.zip",
    "  - url: 0.1.18/Doriterm-0.1.18-arm64.dmg",
    "path: 0.1.18/Doriterm-0.1.18-arm64-mac.zip",
  ]);
  expect(composeFeed(macFeed("0.1.18").replace("url: Doriterm", "url: https://x/Doriterm"), RESOLVED)).toBeNull();
});

test("a files list holding anything but items and their fields is refused", () => {
  expect(composeFeed("version: 0.1.18\nfiles:\n    sha512: aaaa\npath: a.zip\n", RESOLVED)).toBeNull();
  expect(composeFeed("version: 0.1.18\nfiles:\n  - url: a.zip\n  oops: 1\npath: a.zip\n", RESOLVED)).toBeNull();
  expect(composeFeed("  - url: a.zip\nversion: 0.1.18\npath: a.zip\n", RESOLVED)).toBeNull();
});

test("any other YAML spelling of a file line is refused, never passed through unrewritten (#2213 review)", () => {
  const EVIL = "https://evil.example/x.dmg";
  for (const hostile of [
    `version: 0.1.18\nfiles: \n  - url: ${EVIL}\npath: a.zip\n`,
    `version: 0.1.18\nfiles :\n  - url: ${EVIL}\npath: a.zip\n`,
    `version: 0.1.18\nfiles:\n- url: ${EVIL}\npath: a.zip\n`,
    `version: 0.1.18\nfiles: [{url: ${EVIL}}]\npath: a.zip\n`,
    `version: 0.1.18\nfiles:\n  - url: a.zip\n    url: ${EVIL}\npath: a.zip\n`,
    `version: 0.1.18\nfiles:\n  - url: a.zip\n\t\turl: ${EVIL}\npath: a.zip\n`,
    `version: 0.1.18\nupdate:\n  url: ${EVIL}\npath: a.zip\n`,
    `version: 0.1.18\npath : ${EVIL}\n`,
    `version: 0.1.18\n"path": ${EVIL}\n`,
  ]) {
    expect([hostile, composeFeed(hostile, RESOLVED)]).toEqual([hostile, null]);
  }
  // A trailing space after files: is still the files list, so its names are rewritten, not left bare.
  expect(composeFeed("version: 0.1.18\nfiles: \n  - url: a.zip\npath: a.zip\n", RESOLVED)).toContain(
    "  - url: 0.1.18/a.zip\n",
  );
});

test("GitHub's feed is checked for electron-builder's structure, not only its line shapes (#1981 item 6)", () => {
  for (const orphan of [
    "version: 0.1.18\n  - url: a.zip\npath: a.zip\n",
    "version: 0.1.18\nfiles:\n  - url: a.zip\npath: a.zip\n    sha512: aaaa\n",
    "version: 0.1.18\nfiles:\n    sha512: aaaa\npath: a.zip\n",
    "version: 0.1.18\npath: a.zip\n    size: 1\n",
  ]) {
    expect([orphan, githubFeed(orphan)]).toEqual([orphan, null]);
  }
  expect(githubFeed(macFeed("0.1.18"))).toContain(
    "  - url: https://github.com/sisyphuslabs/doriterm/releases/download/v0.1.18/Doriterm-0.1.18-arm64.dmg\n",
  );
});
