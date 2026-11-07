import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", ".github", "scripts", "merge-update-feed.ts");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Asset = { name: string; body: string };

function sha512(body: string): string {
  return new Bun.CryptoHasher("sha512").update(body).digest("base64");
}

function feedYaml(version: string, assets: readonly Asset[]): string {
  const files = assets.map((a) => `  - url: ${a.name}\n    sha512: ${sha512(a.body)}\n    size: ${a.body.length}`);
  const [first] = assets;
  return `version: ${version}\nfiles:\n${files.join("\n")}\npath: ${first?.name}\nsha512: ${sha512(first?.body ?? "")}\nreleaseDate: '2026-11-06T00:00:00.000Z'\n`;
}

/** An assets directory as the release job sees it: the downloads plus one feed-<os>-<arch> directory per runner. */
function assetsDir(feeds: Record<string, Record<string, string>>, assets: readonly Asset[]): string {
  const dir = mkdtempSync(join(tmpdir(), "merge-update-feed-"));
  dirs.push(dir);
  for (const asset of assets) writeFileSync(join(dir, asset.name), asset.body);
  for (const [runner, files] of Object.entries(feeds)) {
    mkdirSync(join(dir, runner));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, runner, name), body);
  }
  return dir;
}

async function run(dir: string, version = "1.2.0"): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, SCRIPT, dir, version], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

type MergedFeed = {
  version: string;
  files: { url: string; sha512: string; size: number }[];
  path: string;
  sha512: string;
};

async function merged(dir: string, name: string): Promise<MergedFeed> {
  return Bun.YAML.parse(await Bun.file(join(dir, name)).text()) as MergedFeed;
}

const armZip = { name: "Doriterm-1.2.0-arm64-mac.zip", body: "arm zip" };
const x64Zip = { name: "Doriterm-1.2.0-x64-mac.zip", body: "x64 zip bytes" };
const armExe = { name: "Doriterm-1.2.0-arm64-setup.exe", body: "arm exe" };
const x64Exe = { name: "Doriterm-1.2.0-x64-setup.exe", body: "x64 exe bytes" };
const appImage = { name: "Doriterm-1.2.0-x86_64.AppImage", body: "appimage" };

test("each feed name becomes one file listing every runner's downloads, and the runner directories go", async () => {
  const dir = assetsDir(
    {
      "feed-mac-arm64": { "latest-mac.yml": feedYaml("1.2.0", [armZip]) },
      "feed-mac-x64": { "latest-mac.yml": feedYaml("1.2.0", [x64Zip]) },
      "feed-win-arm64": { "latest.yml": feedYaml("1.2.0", [armExe]) },
      "feed-win-x64": { "latest.yml": feedYaml("1.2.0", [x64Exe]) },
      "feed-linux-x64": { "latest-linux.yml": feedYaml("1.2.0", [appImage]) },
    },
    [armZip, x64Zip, armExe, x64Exe, appImage],
  );

  const { code, err } = await run(dir);

  expect(err).toBe("");
  expect(code).toBe(0);
  expect(readdirSync(dir).filter((name) => name.startsWith("feed-"))).toEqual([]);
  const mac = await merged(dir, "latest-mac.yml");
  expect(mac.version).toBe("1.2.0");
  expect(mac.files).toEqual([
    { url: armZip.name, sha512: sha512(armZip.body), size: armZip.body.length },
    { url: x64Zip.name, sha512: sha512(x64Zip.body), size: x64Zip.body.length },
  ]);
  const win = Bun.YAML.parse(await Bun.file(join(dir, "latest.yml")).text()) as { files: { url: string }[] };
  expect(win.files.map((file) => file.url)).toEqual([armExe.name, x64Exe.name]);
  expect(existsSync(join(dir, "latest-linux.yml"))).toBe(true);
});

test("a feed naming a file the release does not carry stops the release", async () => {
  const missing = assetsDir({ "feed-mac-arm64": { "latest-mac.yml": feedYaml("1.2.0", [armZip]) } }, []);
  const result = await run(missing);
  expect(result.code).toBe(1);
  expect(result.err).toContain(armZip.name);
});

test("a dmg stapled after its feed was written is listed at the size and SHA-512 the release uploads", async () => {
  const unstapled = { name: "Doriterm-1.2.0-arm64.dmg", body: "dmg as electron-builder measured it" };
  const stapled = { name: unstapled.name, body: `${unstapled.body}, plus the notarization ticket` };
  const dmgFirst = assetsDir({ "feed-mac-arm64": { "latest-mac.yml": feedYaml("1.2.0", [unstapled, armZip]) } }, [
    stapled,
    armZip,
  ]);

  const { code, out, err } = await run(dmgFirst);

  expect(err).toBe("");
  expect(code).toBe(0);
  expect(out).toContain(`${stapled.name} is ${stapled.body.length} bytes as uploaded`);
  const mac = await merged(dmgFirst, "latest-mac.yml");
  expect(mac.files).toEqual([
    { url: stapled.name, sha512: sha512(stapled.body), size: stapled.body.length },
    { url: armZip.name, sha512: sha512(armZip.body), size: armZip.body.length },
  ]);
  expect(mac.path).toBe(stapled.name);
  expect(mac.sha512).toBe(sha512(stapled.body));
});

test("a feed for another version than the release's stops the release", async () => {
  const dir = assetsDir({ "feed-mac-arm64": { "latest-mac.yml": feedYaml("1.2.0", [armZip]) } }, [armZip]);
  const { code, err } = await run(dir, "1.2.1");
  expect(code).toBe(1);
  expect(err).toContain("1.2.1");
});

test("runners that disagree on the version stop the release", async () => {
  const dir = assetsDir(
    {
      "feed-mac-arm64": { "latest-mac.yml": feedYaml("1.2.0", [armZip]) },
      "feed-mac-x64": { "latest-mac.yml": feedYaml("1.2.1", [x64Zip]) },
    },
    [armZip, x64Zip],
  );
  const { code, err } = await run(dir);
  expect(code).toBe(1);
  expect(err).toContain("1.2.1");
});

test("no runner feed at all stops the release", async () => {
  expect((await run(assetsDir({}, [armZip]))).code).toBe(1);
});

// #1016: the zip and the setup.exe ship with the .blockmap electron-builder wrote from their bytes; bytes that changed
// after that would make every differential update fail its check, so only the dmg, which has no blockmap, may change.
test.each([
  ["feed-mac-arm64", "latest-mac.yml", armZip],
  ["feed-win-x64", "latest.yml", x64Exe],
] as const)(
  "a %s download whose bytes changed after its feed was written stops the release",
  async (runner, feedName, built) => {
    const changed = { name: built.name, body: `${built.body}, changed` };
    const dir = assetsDir({ [runner]: { [feedName]: feedYaml("1.2.0", [built]) } }, [changed]);
    const { code, err } = await run(dir);
    expect(code).toBe(1);
    expect(err).toContain(`${built.name} changed after electron-builder wrote its feed and its .blockmap`);
  },
);
