import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HC_VERSION_RECOMMENDED } from "@doriface/protocol";
import { releasePublicKey, signRelease } from "@doriface/crypto";
import { DEFAULT_RELEASES_URL, installHc } from "./hc-install.ts";
import { keepHcCurrent, type Ran } from "./hc-keep-current.ts";

const userHc = (): { hc: string; installDir: string } => {
  const installDir = join(mkdtempSync(join(tmpdir(), "dh-keep-")), "bin");
  mkdirSync(installDir);
  const hc = join(installDir, "hc");
  writeFileSync(hc, "#!/bin/sh\n");
  chmodSync(hc, 0o755);
  return { hc, installDir };
};
const ok = (stdout: string): Ran => ({ code: 0, stdout, stderr: "" });
const listed = (...addresses: string[]): Ran =>
  ok(JSON.stringify({ terminals: addresses.map((address) => ({ address })) }));

/** An hc that answers ls and --version; it fails the test the moment anyone asks it to update itself. */
function fakeHc(lists: Ran[], to: string) {
  const calls: string[][] = [];
  const run = (argv: readonly string[]): Promise<Ran> => {
    calls.push(argv.slice(1));
    if (argv[1] === "update") throw new Error("hc update must never run: it downloads unsigned from herdr's server");
    if (argv[1] === "ls") return Promise.resolve(lists.shift() ?? listed());
    return Promise.resolve(ok(`hc ${to}\n`));
  };
  return { calls, run };
}

const installer = () => {
  const versions: string[] = [];
  return { versions, install: (version: string) => Promise.resolve(versions.push(version)) };
};

test("an older hc in the user's own folder goes to the recommended version through the verified installer, every terminal checked kept", async () => {
  const { hc, installDir } = userHc();
  const fake = fakeHc([listed("t1", "t2"), listed("t1", "t2", "t3")], HC_VERSION_RECOMMENDED);
  const verified = installer();
  const logs: string[] = [];
  const result = await keepHcCurrent({
    hc,
    installDir,
    version: "0.1.21",
    env: {},
    run: fake.run,
    install: verified.install,
    log: (line) => logs.push(line),
  });
  expect(result).toEqual({ kind: "updated", from: "0.1.21", to: HC_VERSION_RECOMMENDED, terminals: 2 });
  expect(verified.versions).toEqual([HC_VERSION_RECOMMENDED]);
  expect(fake.calls).toEqual([["ls", "--json"], ["--version"], ["ls", "--json"]]);
  expect(logs.at(-1)).toContain("all 2 terminals kept running");
});

test("a terminal missing after the update, a refused install, or an old version afterwards is a failure, not a success", async () => {
  const { hc, installDir } = userHc();
  const deps = { hc, installDir, version: "0.1.21", env: {}, install: installer().install, log: () => {} };
  const lost = await keepHcCurrent({
    ...deps,
    run: fakeHc([listed("t1", "t2"), listed("t1")], HC_VERSION_RECOMMENDED).run,
  });
  expect(lost).toEqual({ kind: "failed", reason: "terminals missing after the update: t2" });
  const refused = await keepHcCurrent({
    ...deps,
    run: fakeHc([listed()], "0.1.21").run,
    install: () => Promise.reject(new Error("the core manifest's signature is not one this host trusts")),
  });
  expect(refused).toEqual({ kind: "failed", reason: "the core manifest's signature is not one this host trusts" });
  const stale = await keepHcCurrent({ ...deps, run: fakeHc([listed(), listed()], "0.1.21").run });
  expect(stale).toEqual({ kind: "failed", reason: "hc reports 0.1.21 after the update" });
});

/** A release server like the mirror, but its manifest is signed by a key no build trusts. */
const requests: string[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;
beforeAll(() => {
  const foreign = crypto.getRandomValues(new Uint8Array(32));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      requests.push(url.pathname);
      const build = { url: `${url.origin}/core/${HC_VERSION_RECOMMENDED}/hc.tar.gz`, sha256: "0".repeat(64) };
      const targets = Object.fromEntries(
        ["linux-x86_64", "linux-aarch64", "macos-x86_64", "macos-aarch64"].map((target) => [target, build]),
      );
      const manifest = JSON.stringify({ version: HC_VERSION_RECOMMENDED, generation: 1, targets });
      if (url.pathname === `/core/${HC_VERSION_RECOMMENDED}/manifest.json`) return new Response(manifest);
      if (url.pathname === `/core/${HC_VERSION_RECOMMENDED}/manifest.json.sig`)
        return new Response(signRelease(new TextEncoder().encode(manifest), foreign));
      return new Response("unsigned bytes", { status: 200 });
    },
  });
});
afterAll(async () => {
  await server?.stop(true);
});

test.skipIf(process.platform === "win32")(
  "keep-current never installs a build no Doriterm key signed, and fetches no archive for it",
  async () => {
    expect(DEFAULT_RELEASES_URL).toBe("https://get.doriterm.com");
    const { hc, installDir } = userHc();
    const home = mkdtempSync(join(tmpdir(), "dh-keep-home-"));
    const env = {
      PATH: "/usr/bin:/bin",
      HC_INSTALL_DIR: installDir,
      HERDR_RELEASES_URL: `http://127.0.0.1:${String(server?.port)}`,
    };
    const result = await keepHcCurrent({
      hc,
      installDir,
      version: "0.1.21",
      env,
      run: fakeHc([listed("t1")], "0.1.21").run,
      install: (version) =>
        installHc({ home, env: { ...env, HC_VERSION: version }, trustedKeys: [releasePublicKey(new Uint8Array(32))] }),
      log: () => {},
    });
    expect(result).toEqual({
      kind: "failed",
      reason: "the core manifest's signature is not one this host trusts; nothing was downloaded",
    });
    expect(requests).toEqual([
      `/core/${HC_VERSION_RECOMMENDED}/manifest.json`,
      `/core/${HC_VERSION_RECOMMENDED}/manifest.json.sig`,
    ]);
    expect(readFileSync(hc, "utf8")).toBe("#!/bin/sh\n");
    expect(existsSync(join(installDir, "herdr-core"))).toBe(false);
  },
);

test("nothing runs when hc is current, opted out, or installed outside the user's own folder", async () => {
  const { hc, installDir } = userHc();
  const fake = fakeHc([], HC_VERSION_RECOMMENDED);
  const verified = installer();
  const base = { hc, installDir, env: {}, run: fake.run, install: verified.install, log: () => {} };
  expect(await keepHcCurrent({ ...base, version: HC_VERSION_RECOMMENDED })).toMatchObject({ kind: "skipped" });
  expect(await keepHcCurrent({ ...base, version: "0.1.21", env: { DORIFACE_HC_AUTO_UPDATE: "0" } })).toMatchObject({
    kind: "skipped",
    reason: "DORIFACE_HC_AUTO_UPDATE=0",
  });
  const managed = await keepHcCurrent({
    ...base,
    version: "0.1.21",
    installDir: mkdtempSync(join(tmpdir(), "dh-other-")),
  });
  expect(managed).toMatchObject({
    kind: "skipped",
    reason: "installed outside the user's own folder, so its owner updates it",
  });
  expect(fake.calls).toEqual([]);
  expect(verified.versions).toEqual([]);
});
