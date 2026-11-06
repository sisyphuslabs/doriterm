import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareHcVersions,
  HC_VERSION_FLOOR,
  type HcInstallPhase,
  HcInstallError,
  hcTarget,
  installHc,
  meetsHcFloor,
  parseHcManifest,
} from "./hc-install.ts";

const SHA = "a".repeat(64);

describe("the herdr-core build for this computer", () => {
  test("is the release target for each OS and CPU herdr-core ships, and none for any other", () => {
    expect(hcTarget("linux", "x64")).toBe("linux-x86_64");
    expect(hcTarget("linux", "arm64")).toBe("linux-aarch64");
    expect(hcTarget("darwin", "x64")).toBe("macos-x86_64");
    expect(hcTarget("darwin", "arm64")).toBe("macos-aarch64");
    expect(hcTarget("win32", "x64")).toBe("windows-x86_64");
    expect(hcTarget("win32", "arm64")).toBeUndefined();
    expect(hcTarget("linux", "ia32")).toBeUndefined();
    expect(hcTarget("linux", "riscv64")).toBeUndefined();
    expect(hcTarget("freebsd", "x64")).toBeUndefined();
  });
});

describe("the version floor", () => {
  test(`is ${HC_VERSION_FLOOR}: older is refused, the same or newer is taken, numbers compare as numbers`, () => {
    expect(HC_VERSION_FLOOR).toBe("0.1.17");
    expect(meetsHcFloor("0.1.16")).toBe(false);
    expect(meetsHcFloor("0.1.9")).toBe(false);
    expect(meetsHcFloor("0.0.99")).toBe(false);
    expect(meetsHcFloor("0.1.17")).toBe(true);
    expect(meetsHcFloor("0.1.18")).toBe(true);
    expect(meetsHcFloor("0.2.0")).toBe(true);
    expect(meetsHcFloor("1.0.0")).toBe(true);
    expect(compareHcVersions("hc 0.1.18", "0.1.17")).toBeGreaterThan(0);
    expect(compareHcVersions("0.1.17-rc.1", "0.1.17")).toBe(0);
  });
});

const manifest = (targets: object): string => JSON.stringify({ version: "0.1.18", generation: 1, targets });

/** Why the manifest was refused. */
const refused = (text: string): string => {
  try {
    parseHcManifest(text, "linux-x86_64");
  } catch (error) {
    if (error instanceof HcInstallError && error.phase === "manifest") return error.message;
  }
  throw new Error("not refused");
};

describe("the release manifest", () => {
  test("names the version, URL and sha256 of the build for a target", () => {
    const text = manifest({ "linux-x86_64": { url: "https://r.example/hc.tar.gz", sha256: SHA.toUpperCase() } });
    expect(parseHcManifest(text, "linux-x86_64")).toEqual({
      version: "0.1.18",
      url: "https://r.example/hc.tar.gz",
      sha256: SHA,
    });
  });

  test("without the target, a sha256, a URL or JSON at all is refused with why", () => {
    expect(refused(manifest({ "macos-aarch64": { url: "https://r.example/a", sha256: SHA } }))).toBe(
      "herdr-core 0.1.18 has no build for linux-x86_64",
    );
    expect(refused(manifest({ "linux-x86_64": { url: "https://r.example/a", sha256: "abc" } }))).toContain("no build");
    expect(refused(manifest({ "linux-x86_64": { url: "not a url", sha256: SHA } }))).toContain("not one");
    expect(refused(JSON.stringify({ targets: {} }))).toBe("the release manifest names no version");
    expect(refused("<html>")).toBe("the release manifest is not JSON");
  });
});

/** A release server on port 0 serving one fake hc build for every target. */
interface Release {
  version: string;
  sha256?: string;
  script: string;
}

const dirs: string[] = [];
const scratch = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `dh-${name}-`));
  dirs.push(dir);
  return dir;
};

const hcScript = (version: string): string =>
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "hc ${version}"; exit 0; fi\nexit 9\n`;

async function archive(script: string): Promise<Uint8Array> {
  const dir = scratch("build");
  writeFileSync(join(dir, "herdr-core"), script, { mode: 0o755 });
  writeFileSync(join(dir, "LICENSE"), "fixture\n");
  const tar = Bun.spawn(["tar", "-czf", "-", "-C", dir, "herdr-core", "LICENSE"], { stdout: "pipe" });
  const bytes = new Uint8Array(await new Response(tar.stdout).arrayBuffer());
  expect(await tar.exited).toBe(0);
  return bytes;
}

/**
 * Each script's archive is built once, so the sha256 the manifest announces is the hash of the very bytes the download
 * serves. Two tar runs need not give the same bytes: each writes its files anew, and tar records their times (whole
 * seconds in GNU tar, more on macOS), so a build per request served a different archive than the one hashed (#497).
 */
const builds = new Map<string, Promise<Uint8Array>>();
function built(script: string): Promise<Uint8Array> {
  let bytes = builds.get(script);
  if (bytes === undefined) {
    bytes = archive(script);
    builds.set(script, bytes);
  }
  return bytes;
}

let release: Release = { version: "0.1.18", script: hcScript("0.1.18") };
const requests: string[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      requests.push(url.pathname + url.search);
      const bytes = await built(release.script);
      const sha256 = release.sha256 ?? new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      if (url.pathname === "/core/latest.json") {
        const build = { url: `${url.origin}/core/${release.version}/hc.tar.gz`, sha256 };
        const targets = Object.fromEntries(
          ["linux-x86_64", "linux-aarch64", "macos-x86_64", "macos-aarch64"].map((target) => [target, build]),
        );
        return Response.json({ version: release.version, generation: 1, targets });
      }
      if (url.pathname === `/core/${release.version}/hc.tar.gz`) return new Response(bytes);
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(async () => {
  await server?.stop(true);
});
afterEach(() => {
  requests.length = 0;
  release = { version: "0.1.18", script: hcScript("0.1.18") };
  builds.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `doriface-host --install-hc` with `home` as HOME, against the fixture release server. */
async function cli(home: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "--install-hc"], {
    env: { PATH: "/usr/bin:/bin", HOME: home, HERDR_RELEASES_URL: `http://127.0.0.1:${String(server?.port)}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

async function install(home: string): Promise<{ phases: HcInstallPhase[]; done: Promise<unknown> }> {
  const phases: HcInstallPhase[] = [];
  const env = { PATH: "/usr/bin:/bin", HERDR_RELEASES_URL: `http://127.0.0.1:${String(server?.port)}/` };
  const done = installHc({ home, env, onPhase: (phase) => phases.push(phase) });
  return { phases, done };
}

const failure = async (done: Promise<unknown>): Promise<HcInstallError> => {
  const error: unknown = await done.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof HcInstallError)) throw new Error(`expected an HcInstallError, got ${String(error)}`);
  return error;
};

describe.skipIf(process.platform === "win32")("installing herdr-core from a release server", () => {
  test("verifies, runs and installs it into ~/.local/bin with hc beside it, reporting each phase", async () => {
    const home = scratch("home");
    const { phases, done } = await install(home);
    const bin = join(home, ".local", "bin");
    expect(await done).toEqual({ version: "0.1.18", path: join(bin, "herdr-core"), action: "installed" });
    expect(phases).toEqual(["manifest", "download", "verify", "extract", "check", "install"]);
    expect(lstatSync(join(bin, "herdr-core")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(bin, "herdr-core"), "utf8")).toBe(hcScript("0.1.18"));
    expect(readlinkSync(join(bin, "hc"))).toBe("herdr-core");
    expect(existsSync(join(bin, "herdr-core.new"))).toBe(false);
    expect(requests).toEqual(["/core/latest.json", "/core/0.1.18/hc.tar.gz?src=install"]);
  });

  test("a download whose sha256 does not match is refused and nothing is installed", async () => {
    release = { ...release, sha256: "0".repeat(64) };
    const home = scratch("home");
    const { phases, done } = await install(home);
    const error = await failure(done);
    expect(error.phase).toBe("verify");
    expect(error.message).toStartWith("the download is damaged (checksum mismatch: expected 000");
    expect(error.message).toEndWith("nothing was installed");
    expect(phases).toEqual(["manifest", "download", "verify"]);
    expect(existsSync(join(home, ".local"))).toBe(false);
  });

  test("an hc already there is swapped through its own update --from, so its terminals keep running", async () => {
    const home = scratch("home");
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    // The old hc takes the new one the way hc update --from does: it copies it over itself.
    const old = `#!/bin/sh\nif [ "$1" = update ] && [ "$2" = --from ]; then echo "$3" > "${bin}/updated-from"; cp "$3" "$0"; exit 0; fi\necho "hc 0.1.16"\n`;
    writeFileSync(join(bin, "herdr-core"), old, { mode: 0o755 });
    const { done } = await install(home);
    expect(await done).toEqual({ version: "0.1.18", path: join(bin, "herdr-core"), action: "updated" });
    expect(readFileSync(join(bin, "updated-from"), "utf8")).toEndWith("/herdr-core\n");
    expect(readFileSync(join(bin, "herdr-core"), "utf8")).toBe(hcScript("0.1.18"));
    expect(requests).toContain("/core/0.1.18/hc.tar.gz?src=update");
  });

  test("a build that does not run here, or one older than the floor, is refused before anything is installed", async () => {
    release = { version: "0.1.18", script: "#!/bin/sh\necho 'wrong arch' >&2\nexit 126\n" };
    const broken = scratch("home");
    const run = await failure((await install(broken)).done);
    expect([run.phase, run.message]).toEqual([
      "check",
      "the downloaded herdr-core does not run on this computer: wrong arch",
    ]);
    expect(existsSync(join(broken, ".local"))).toBe(false);

    release = { version: "0.1.16", script: hcScript("0.1.16") };
    const old = scratch("home");
    const floor = await failure((await install(old)).done);
    expect([floor.phase, floor.message]).toEqual([
      "manifest",
      "herdr-core 0.1.16 is older than 0.1.17, which Doriterm needs",
    ]);
    expect(existsSync(join(old, ".local"))).toBe(false);
  });

  test("doriface-host --install-hc installs it, and a checksum mismatch exits 1 with the cause and no usage", async () => {
    const home = scratch("home");
    const bin = join(home, ".local", "bin");
    const done = await cli(home);
    expect(done.code).toBe(0);
    expect(done.out).toBe(
      `herdr-core 0.1.18 installed at ${bin}/herdr-core\nAdd ${bin} to your PATH, or pass --hc ${bin}/herdr-core.\n`,
    );
    expect(done.err).toContain("installing herdr-core: verify");

    release = { ...release, sha256: "0".repeat(64) };
    const other = scratch("home");
    const damaged = await cli(other);
    expect(damaged.code).toBe(1);
    expect(damaged.err).toContain("doriface-host --install-hc: the download is damaged (checksum mismatch");
    expect(damaged.err).not.toContain("usage:");
    expect(existsSync(join(other, ".local"))).toBe(false);
  });
});
