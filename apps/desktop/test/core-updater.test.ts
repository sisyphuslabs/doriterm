import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreUpdater } from "../src/main/core-updater.ts";
import type { HostContext } from "../src/main/host-command.ts";

const RELEASE = "0.1.22";
const INSTALLED = "0.1.21";

function executable(version: string, running: string) {
  return `#!/bin/sh
set -eu
case "$1" in
  --version) printf '%s\\n' 'hc ${version}';;
  server) printf '%s\\n' '{"installed_by":null,"version":"${running}"}';;
  update)
    if [ "$3" = '--from' ]; then source="$4"; else source="$CORE_NEXT"; fi
    cp "$source" "$0.new"
    chmod 755 "$0.new"
    mv "$0.new" "$0"
    ;;
  *) exit 2;;
esac
`;
}

async function fixture(runningAfter: string, useManagedBinary = false) {
  const home = await mkdtemp(join(tmpdir(), "dori-core-update-"));
  const bin = join(home, "install");
  await mkdir(bin);
  const installed = join(bin, "herdr-core");
  const candidate = join(home, "next-herdr-core");
  const original = executable(INSTALLED, INSTALLED);
  await writeFile(installed, original, { mode: 0o755 });
  await writeFile(candidate, executable(RELEASE, runningAfter), { mode: 0o755 });
  const feed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/core/latest.json": Response.json({
        version: RELEASE,
        generation: 1,
        targets: Object.fromEntries(
          ["linux-x86_64", "linux-aarch64"].map((arch) => [
            arch,
            { url: "https://example.test/herdr-core.tar.gz", sha256: "1".repeat(64) },
          ]),
        ),
      }),
    },
  });
  const context: HostContext = {
    home,
    packaged: false,
    appPath: home,
    resourcesPath: home,
    platform: "linux",
    env: {
      ...process.env,
      HC_INSTALL_DIR: bin,
      HERDR_RELEASES_URL: feed.url.origin,
      CORE_NEXT: candidate,
    },
  };
  return {
    updater: new CoreUpdater(context, () => (useManagedBinary ? candidate : installed)),
    installed,
    original,
    candidate,
    async [Symbol.asyncDispose]() {
      await feed.stop();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test.skipIf(process.platform === "win32")("refuses an executable outside the user install", async () => {
  await using core = await fixture(RELEASE, true);
  expect((await core.updater.check()).state).toBe("unavailable");
});

test.skipIf(process.platform === "win32")(
  "a checked update leaves the installation unchanged when cancelled",
  async () => {
    await using core = await fixture(RELEASE);
    const offer = await core.updater.check();
    expect(offer).toEqual({ state: "available", current: INSTALLED, version: RELEASE });
    expect(await core.updater.apply(async () => false)).toEqual(offer);
    expect(await readFile(core.installed, "utf8")).toBe(core.original);
  },
);

test.skipIf(process.platform === "win32")(
  "a changed installation requires checking again before updating",
  async () => {
    await using core = await fixture(RELEASE);
    await core.updater.check();
    const changed = `${core.original}\n# changed by another installer`;
    await writeFile(core.installed, changed);
    expect((await core.updater.apply(async () => true)).state).toBe("unavailable");
    expect(await readFile(core.installed, "utf8")).toBe(changed);
  },
);

test.skipIf(process.platform === "win32")(
  "restores the prior executable when the new core does not come back",
  async () => {
    await using core = await fixture(INSTALLED);
    await core.updater.check();
    expect(await core.updater.apply(async () => true)).toEqual({ state: "restored", version: INSTALLED });
    expect(await readFile(core.installed, "utf8")).toBe(core.original);
  },
);
