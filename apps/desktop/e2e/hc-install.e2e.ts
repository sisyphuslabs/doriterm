import { hcTarget } from "@doriface/host/hc-install";
import { _electron as electron, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions, pressNewTab } from "./launch.ts";

/** The real hc the fixture release serves: CI's HC_BIN, else the one installed on this machine. */
const realHc = process.env["HC_BIN"] || join(homedir(), ".local", "bin", "herdr-core");

const runnable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** This machine's PATH without any folder that holds an hc, so the app finds none until it installs one. */
const pathWithoutHc = (): string[] =>
  (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "" && !runnable(join(dir, "hc")) && !runnable(join(dir, "herdr-core")));

/** A release server serving latest.json and one archive holding the real hc; `sha256` is what the manifest claims. */
async function releaseServer(archive: Buffer, version: string, target: string) {
  const state = { sha256: "0".repeat(64) };
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    const origin = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
    if (path === "/core/latest.json") {
      const build = { url: `${origin}/core/${version}/herdr-core-${target}.tar.gz`, sha256: state.sha256 };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ version, generation: 1, notes: "fixture", targets: { [target]: build } }));
    } else if (path === `/core/${version}/herdr-core-${target}.tar.gz`) {
      response.end(archive);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("with no hc anywhere, Install herdr-core refuses a damaged download, then installs a verified one and attaches", async () => {
  test.setTimeout(120_000);
  const target = hcTarget(process.platform, process.arch);
  test.skip(
    target === undefined || process.platform === "win32",
    "the fixture archive is a tar.gz of this machine's hc",
  );
  if (target === undefined) return;
  if (!runnable(realHc)) throw new Error(`the install test needs a real hc at ${realHc} (or HC_BIN)`);

  const dir = mkdtempSync(join(tmpdir(), "dd-hc-install-"));
  const home = join(dir, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(home, { recursive: true });
  // Its own core, state and socket: the installed hc must never reach (or start) this machine's default core.
  const hc = scratchHcSession(realHc);
  const isolated = { ...process.env, ...hc.env };
  const version = execFileSync(realHc, ["--version"], { env: isolated, encoding: "utf8" }).trim().replace(/^hc /, "");

  const build = join(dir, "build");
  mkdirSync(build);
  copyFileSync(realHc, join(build, "herdr-core"));
  execFileSync("tar", ["-czf", join(dir, "hc.tar.gz"), "-C", build, "herdr-core"]);
  const archive = readFileSync(join(dir, "hc.tar.gz"));
  const release = await releaseServer(archive, version, target);

  // A shell that starts clean, as in terminal.e2e.ts.
  writeFileSync(join(home, "clean-shell"), "#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n", { mode: 0o755 });
  const env = Object.fromEntries(
    Object.entries({
      ...isolated,
      HC_BIN: undefined,
      HC_INSTALL_DIR: undefined,
      HC_VERSION: undefined,
      HERDR_RELEASES_URL: release.url,
      HOME: home,
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      DORIFACE_HOST_STATE_DIR: join(dir, "host-state"),
      PATH: [home, ...pathWithoutHc()].join(delimiter),
      SHELL: "clean-shell",
      PS1: "$ ",
      ENV: "",
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const app = await electron.launch(await launchOptions([`--user-data-dir=${join(dir, "profile")}`], { env }));
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Use this computer" }).click();
    const notice = page.getByRole("alert").filter({ hasText: "This computer's host did not start" });
    await expect(notice.locator("[data-host-start-code]")).toHaveAttribute(
      "data-host-start-code",
      "hc-binary-missing",
      {
        timeout: 20_000,
      },
    );

    // The manifest's sha256 is not the archive's: refused, with the cause, and nothing lands in ~/.local/bin.
    await notice.getByRole("button", { name: "Install herdr-core" }).click();
    const refused = notice.locator("[data-hc-install-error]");
    await expect(refused).toContainText("the download is damaged (checksum mismatch", { timeout: 20_000 });
    expect(existsSync(join(bin, "herdr-core"))).toBe(false);
    await page.screenshot({ path: test.info().outputPath("hc-install-refused.png") });

    release.state.sha256 = createHash("sha256").update(archive).digest("hex");
    await notice.getByRole("button", { name: "Retry install" }).click();
    // Installed, then the host started again on its own: the workspace replaces the notice.
    await pressNewTab(page, { timeout: 45_000 });
    const terminal = page.locator('[data-focused="true"] [data-terminal]');
    await expect(terminal).toContainText("$", { timeout: 30_000 });
    expect(readFileSync(join(bin, "herdr-core")).equals(readFileSync(realHc))).toBe(true);
    expect(readlinkSync(join(bin, "hc"))).toBe("herdr-core");
    await page.screenshot({ path: test.info().outputPath("hc-installed-terminal.png") });
  } finally {
    await app.close();
    await release.close();
    await hc.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
