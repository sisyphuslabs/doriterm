import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// install.sh as release.yml publishes it: stamped with its tag, so it installs that release (#1969).
const SCRIPT = readFileSync(join(import.meta.dir, "install.sh"), "utf8");
const sha256 = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

interface Options {
  /** Which bases hold the release: get.doriterm.com's /v/0.1.17, the GitHub release, or both. */
  readonly on: readonly ("get" | "github")[];
  readonly signature?: "valid" | "invalid" | "none";
  /** Whether the binary lists --auto-update in its --help (a host from before #1969 does not). */
  readonly autoUpdate?: boolean;
  /** The release the script is stamped with (default v0.1.17, from before releases were signed). */
  readonly release?: string;
}

function rig(options: Options) {
  const root = mkdtempSync(join(tmpdir(), "df-install-get-"));
  roots.push(root);
  const release = options.release ?? "v0.1.17";
  const [home, stubs, get, github] = ["home", "stubs", `get/v/${release.slice(1)}`, `github/download/${release}`].map(
    (d) => join(root, d),
  );
  const log = join(root, "calls.log");
  for (const dir of [home, stubs]) mkdirSync(dir ?? "", { recursive: true });
  writeFileSync(log, "");
  const stub = (name: string, body: string): void => {
    writeFileSync(join(stubs ?? "", name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(stubs ?? "", name), 0o755);
  };
  stub("uname", '[ "$1" = -s ] && echo Linux || echo x86_64');
  stub("systemctl", `echo "systemctl $*" >> "${log}"`);
  // The user lingers already, so the installer never reaches the real loginctl to turn it on.
  stub("loginctl", "echo yes");
  stub("hc", "echo 0.1.17");
  const host = [
    "#!/bin/sh",
    `echo "doriface-host $*" >> "${log}"`,
    `if [ "$1" = --help ]; then echo "${options.autoUpdate === false ? "" : "  --auto-update <ch>"}"; fi`,
    `if [ "$1" = verify-release ]; then [ "$(cat "$3")" = valid ] && exit 0; exit 1; fi`,
    "",
  ].join("\n");
  for (const [name, base] of [
    ["get", get],
    ["github", github],
  ] as const) {
    if (!options.on.includes(name) || base === undefined) continue;
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "doriface-host-linux-x64"), host);
    writeFileSync(join(base, "SHA256SUMS.txt"), `${sha256(host)}  doriface-host-linux-x64\n`);
    if ((options.signature ?? "valid") !== "none")
      writeFileSync(join(base, "SHA256SUMS.txt.sig"), options.signature ?? "valid");
  }
  const script = join(root, "install.sh");
  writeFileSync(script, SCRIPT.replaceAll("__DORIFACE_RELEASE__", release));
  const run = (...args: string[]) => {
    const proc = Bun.spawnSync(["/bin/sh", script, "--no-pair", ...args], {
      env: {
        HOME: home,
        PATH: [stubs, "/usr/bin", "/bin"].join(":"),
        SHELL: "/bin/sh",
        TMPDIR: root,
        DORIFACE_GET_ORIGIN: `file://${join(root, "get")}`,
        DORIFACE_GITHUB_RELEASES: `file://${join(root, "github")}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const unit = join(home ?? "", ".config", "systemd", "user", "doriface-host.service");
    return {
      code: proc.exitCode,
      out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
      calls: readFileSync(log, "utf8").trim().split("\n"),
      installed: existsSync(join(home ?? "", ".local", "bin", "doriface-host")),
      execStart: existsSync(unit) ? (readFileSync(unit, "utf8").match(/^ExecStart=.*$/m)?.[0] ?? "") : "",
    };
  };
  return { run, root };
}

test("a stamped install.sh downloads its release from get.doriterm.com, has the binary check the signature, and updates itself", () => {
  const result = rig({ on: ["get", "github"] }).run();
  expect(result.code).toBe(0);
  expect(result.out).toContain("/get/v/0.1.17");
  expect(result.out).not.toContain("/github/");
  expect(result.calls.slice(0, 2)).toEqual([
    "systemctl --user show-environment",
    expect.stringMatching(/^doriface-host verify-release .*SHA256SUMS\.txt .*SHA256SUMS\.txt\.sig$/),
  ]);
  expect(result.installed).toBe(true);
  expect(result.execStart).toEndWith("--auto-update stable");
});

test("when get.doriterm.com does not answer, the same release comes from GitHub", () => {
  const result = rig({ on: ["github"] }).run();
  expect(result.code).toBe(0);
  expect(result.out).toContain("did not answer; using file://");
  expect(result.out).toContain("/github/download/v0.1.17");
  expect(result.installed).toBe(true);
});

test("a signature that does not verify installs nothing; a release with no signature says so and installs", () => {
  const bad = rig({ on: ["get"], signature: "invalid" }).run();
  expect(bad.code).toBe(1);
  expect(bad.out).toContain("SHA256SUMS.txt is not signed by a Doriterm release key; nothing was installed");
  expect(bad.installed).toBe(false);
  const unsigned = rig({ on: ["get"], signature: "none" }).run();
  expect(unsigned.code).toBe(0);
  expect(unsigned.out).toContain("this release carries no SHA256SUMS.txt.sig");
});

test("a release from v0.1.18 on, when releases are signed, installs nothing without its signature (#1983)", () => {
  for (const release of ["v0.1.18", "v0.2.0", "v1.0.0-beta.1"]) {
    const unsigned = rig({ on: ["get"], signature: "none", release }).run();
    expect([release, unsigned.code, unsigned.installed]).toEqual([release, 1, false]);
    expect(unsigned.out).toContain(
      `${release} is signed, but no SHA256SUMS.txt.sig came with it; nothing was installed`,
    );
    expect(rig({ on: ["get"], release }).run().code).toBe(0);
  }
});

test("a stamped v0.1.18+ install.sh given --from still names its release, so a missing signature installs nothing (#2297)", () => {
  const r = rig({ on: ["get"], signature: "none", release: "v0.1.18" });
  const unsigned = r.run("--from", `file://${join(r.root, "get", "v", "0.1.18")}`);
  expect([unsigned.code, unsigned.installed]).toEqual([1, false]);
  expect(unsigned.out).toContain("v0.1.18 is signed, but no SHA256SUMS.txt.sig came with it; nothing was installed");
});

test("--channel beta and --no-auto-update reach the service, and a host without --auto-update gets no flag", () => {
  expect(rig({ on: ["get"] }).run("--channel", "beta").execStart).toEndWith("--auto-update beta");
  expect(rig({ on: ["get"] }).run("--no-auto-update").execStart).toEndWith("--auto-update off");
  expect(rig({ on: ["get"], autoUpdate: false }).run().execStart).not.toContain("--auto-update");
  const refused = rig({ on: ["get"] }).run("--channel", "nightly");
  expect([refused.code, refused.out]).toEqual([1, "Doriterm: --channel wants stable or beta, not nightly\n"]);
});
