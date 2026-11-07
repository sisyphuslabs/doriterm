// The update feed electron-updater reads from a GitHub release: latest-mac.yml, latest.yml (Windows),
// latest-linux.yml and latest-linux-arm64.yml. Each desktop runner builds one OS and one CPU, so the two macOS runners
// each write a latest-mac.yml and the two Windows runners each write a latest.yml. A release carries one file per name,
// listing every architecture's download; the updater picks its own by file name (MacUpdater.filterFilesForArch on
// "arm64", Provider.findFile on process.arch). This merges the runners' copies into one file per name in the assets
// directory.
//
// The size and SHA-512 of every file the feed names come from the file in the assets directory, the bytes the release
// uploads, not from the runner's feed: electron-builder writes the feed while it builds, and the macOS runner staples
// the notarization ticket to the dmg after that, which changes the dmg's bytes. An entry whose numbers changed is
// printed. A feed that names a file the release does not carry, or a version other than the release's, stops it.
//
// usage: bun .github/scripts/merge-update-feed.ts <assets dir> <version>
// Reads <assets dir>/feed-<os>-<arch>/latest*.yml, writes <assets dir>/latest*.yml and removes the feed-* directories.
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type FeedFile = { url: string; sha512: string; size: number; [key: string]: unknown };
type Feed = { version: string; files: FeedFile[]; path?: string; sha512?: string; releaseDate?: string };

function fail(message: string): never {
  console.error(`merge-update-feed: ${message}`);
  process.exit(1);
}

function readFeed(file: string): Feed {
  const parsed: unknown = Bun.YAML.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null) fail(`${file} is not a YAML mapping`);
  const feed = parsed as Partial<Feed>;
  if (typeof feed.version !== "string" || !Array.isArray(feed.files) || feed.files.length === 0) {
    fail(`${file} has no version or no files`);
  }
  return feed as Feed;
}

function sha512(file: string): string {
  return new Bun.CryptoHasher("sha512").update(readFileSync(file)).digest("base64");
}

const [assetsDir, version] = Bun.argv.slice(2);
if (assetsDir === undefined || version === undefined || version === "") {
  console.error("usage: bun .github/scripts/merge-update-feed.ts <assets dir> <version>");
  process.exit(2);
}

const feedDirs = readdirSync(assetsDir)
  .filter((name) => name.startsWith("feed-") && statSync(join(assetsDir, name)).isDirectory())
  .toSorted();
if (feedDirs.length === 0) fail(`no feed-* directory in ${assetsDir}`);

const byName = new Map<string, Feed[]>();
for (const dir of feedDirs) {
  const names = readdirSync(join(assetsDir, dir)).filter((name) => /^latest.*\.yml$/.test(name));
  if (names.length === 0) fail(`${dir} has no latest*.yml`);
  for (const name of names) {
    const feed = readFeed(join(assetsDir, dir, name));
    if (feed.version !== version) fail(`${dir}/${name} is for version ${feed.version}, the release is ${version}`);
    byName.set(name, [...(byName.get(name) ?? []), feed]);
  }
}

function measured(name: string, url: string): { size: number; sha512: string } {
  const path = join(assetsDir, url);
  if (!existsSync(path)) fail(`${name} names ${url}, which is not among the release's files`);
  return { size: statSync(path).size, sha512: sha512(path) };
}

for (const [name, feeds] of [...byName].toSorted(([a], [b]) => a.localeCompare(b))) {
  const files = new Map<string, FeedFile>();
  for (const file of feeds.flatMap((feed) => feed.files)) {
    if (files.has(file.url)) fail(`${name}: ${file.url} is listed twice`);
    const actual = measured(name, file.url);
    if (actual.size !== file.size || actual.sha512 !== file.sha512) {
      console.log(`${name}: ${file.url} is ${actual.size} bytes as uploaded, the runner's feed said ${file.size}`);
    }
    files.set(file.url, { ...file, ...actual });
  }
  const [first] = feeds;
  const merged: Feed = { ...first, files: [...files.values()] };
  if (first.path !== undefined) merged.sha512 = measured(name, first.path).sha512;
  writeFileSync(join(assetsDir, name), Bun.YAML.stringify(merged, null, 2) + "\n");
  console.log(`${name}: version ${version}, ${[...files.keys()].join(", ")}`);
}

for (const dir of feedDirs) rmSync(join(assetsDir, dir), { recursive: true });
