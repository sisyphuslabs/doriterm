import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "install.sh");
/** The name `id -un` gives in every rig: the installer asks the system who the user is, never the environment. */
const USER = "dori-user";

interface Rig {
  readonly root: string;
  readonly home: string;
  readonly release: string;
  readonly stubs: string;
  readonly log: string;
}

const rigs: string[] = [];
afterEach(() => {
  for (const dir of rigs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const stub = (dir: string, name: string, body: string): void => {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
};

/**
 * A launchd that remembers whether the agent is loaded: bootout unloads it, print finds it only while it is loaded, and
 * bootstrap loads it, except that the first `failures` bootstraps fail with 5 (EIO), as launchd's do for a while after
 * an agent it is still unloading has already left `print` (#1966).
 */
function launchd(dir: string, log: string, failures = 0): string {
  const state = join(dir, "launchd-state");
  const left = join(dir, "launchd-failures");
  writeFileSync(state, "gone");
  writeFileSync(left, String(failures));
  stub(
    dir,
    "launchctl",
    [
      `echo "launchctl $*" >> "${log}"`,
      `case "$1" in`,
      `  bootout) echo gone > "${state}" ;;`,
      `  print) [ "$(cat "${state}")" = loaded ] || exit 113 ;;`,
      `  bootstrap) n=$(cat "${left}"); if [ "$n" -gt 0 ]; then echo $((n - 1)) > "${left}"; echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi; echo loaded > "${state}" ;;`,
      `esac`,
    ].join("\n"),
  );
  return state;
}

/**
 * A logind that remembers whether the user lingers: `show-user` answers it, and `enable-linger` turns it on when the
 * system grants that to the user, or fails as it does where an admin has to do it.
 */
function lingering(dir: string, log: string, linger: "yes" | "no", enable: "granted" | "refused"): void {
  const state = join(dir, "linger-state");
  writeFileSync(state, linger);
  stub(
    dir,
    "loginctl",
    [
      `case "$*" in`,
      `  *show-user*) cat "${state}" ;;`,
      `  *enable-linger*) echo "loginctl $*" >> "${log}"; ${enable === "granted" ? `printf yes > "${state}"` : "exit 1"} ;;`,
      `esac`,
    ].join("\n"),
  );
}

const enabledLinger = (calls: readonly string[]): string[] => calls.filter((call) => call.startsWith("loginctl"));

const sha256 = (bytes: string): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/**
 * A HOME, a file:// release holding a fake doriface-host and its SHA256SUMS.txt, and stubs for uname and the service
 * managers that append every call to one log, so a test reads what the installer did in order.
 */
function rig(system: "Linux" | "Darwin", machine = "x86_64"): Rig {
  const root = mkdtempSync(join(tmpdir(), "df-install-"));
  rigs.push(root);
  const home = join(root, "home");
  const release = join(root, "release");
  const stubs = join(root, "stubs");
  const log = join(root, "calls.log");
  for (const dir of [home, release, stubs]) mkdirSync(dir, { recursive: true });
  writeFileSync(log, "");
  stub(stubs, "uname", `[ "$1" = -s ] && echo ${system} || echo ${machine}`);
  // Who the user is comes from this stub, so no case depends on the account or the environment that runs the tests.
  stub(stubs, "id", `if [ "$*" = -un ]; then echo ${USER}; else exec /usr/bin/id "$@"; fi`);
  stub(stubs, "systemctl", `echo "systemctl $*" >> "${log}"`);
  // The user lingers already, so no test reaches the real loginctl and changes the machine it runs on.
  lingering(stubs, log, "yes", "granted");
  // No agent is loaded yet, as on a computer that never ran the host.
  launchd(stubs, log);
  const os = system === "Linux" ? "linux" : "mac";
  const arch = machine === "x86_64" ? "x64" : "arm64";
  const host = [
    "#!/bin/sh",
    `echo "doriface-host $*" >> "${log}"`,
    `if [ "$1" = --install-hc ]; then mkdir -p "$HOME/.local/bin"; printf '#!/bin/sh\\necho 0.1.17\\n' > "$HOME/.local/bin/hc"; chmod 755 "$HOME/.local/bin/hc"; fi`,
    `if [ "$1" = pair ]; then echo "doriface://pair#h=fake"; fi`,
    // What mesh join read from --from-file, and the file's mode, as the host saw them while it ran.
    `prev=""; for a in "$@"; do if [ "$prev" = --from-file ]; then echo "from-file $(cat "$a") $(stat -c %a "$a" 2>/dev/null || stat -f %Lp "$a")" >> "${log}"; fi; prev="$a"; done`,
    "",
  ].join("\n");
  const asset = `doriface-host-${os}-${arch}`;
  writeFileSync(join(release, asset), host);
  writeFileSync(join(release, "SHA256SUMS.txt"), `${sha256(host)}  ${asset}\n${"0".repeat(64)}  other.zip\n`);
  return { root, home, release, stubs, log };
}

function install(
  r: Rig,
  args: readonly string[] = [],
  extraPath: readonly string[] = [],
  extraEnv: Readonly<Record<string, string>> = {},
  cwd?: string,
) {
  const proc = Bun.spawnSync(["/bin/sh", SCRIPT, "--from", `file://${r.release}`, ...args], {
    cwd,
    env: {
      HOME: r.home,
      PATH: [r.stubs, ...extraPath, "/usr/bin", "/bin"].join(":"),
      SHELL: "/bin/zsh",
      TMPDIR: r.root,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
    calls: readFileSync(r.log, "utf8").trim().split("\n").filter(Boolean),
  };
}

const LINK = "doriface://pair#h=a&m=1";

/**
 * The installer ran `mesh join` with the link in a file this user alone can read, and never with the link on any
 * command line, where other local users can read it (#1201); the spent file is gone once the installer exits.
 */
function expectJoinedFromFile(calls: readonly string[], command: string): void {
  const joinCall = calls.find((call) => call.startsWith(command));
  expect(joinCall).toBeDefined();
  const file = (joinCall ?? "").slice(command.length);
  expect(calls).toContain(`from-file ${LINK} 600`);
  expect(calls.filter((call) => call.startsWith("doriface-host") && call.includes(LINK))).toEqual([]);
  expect(existsSync(file)).toBe(false);
}

describe("install.sh on Linux", () => {
  test("installs the checked binary and herdr-core, registers the user service, then waits for it and pairs", () => {
    const r = rig("Linux");
    const run = install(r, ["--web-origin", "https://app.example"]);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const bin = join(r.home, ".local", "bin");
    const hc = join(bin, "hc");
    expect(run.calls).toEqual([
      "systemctl --user show-environment",
      "doriface-host --install-hc",
      "doriface-host --help",
      "systemctl --user daemon-reload",
      "systemctl --user enable doriface-host.service",
      "systemctl --user restart doriface-host.service",
      `doriface-host pair --wait-host 60 --state-dir ${join(r.home, ".local", "state", "doriface-host")} --web-origin https://app.example`,
    ]);
    const unit = readFileSync(join(r.home, ".config", "systemd", "user", "doriface-host.service"), "utf8");
    expect(unit).toContain(
      `ExecStart="${join(bin, "doriface-host")}" --hc "${hc}" --state-dir "${join(r.home, ".local", "state", "doriface-host")}"`,
    );
    expect(unit).toContain(`Environment="PATH=${bin}:${bin}:${r.stubs}:/usr/bin:/bin" "SHELL=/bin/zsh"`);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("CPUWeight=10000");
    expect(unit).toContain("IOWeight=10000");
    expect(unit).not.toMatch(/^Nice=/m);
    expect(unit).toContain("WantedBy=default.target");
    expect(run.out).toContain("doriface://pair#h=fake");
  });

  test("--join joins the mesh of the host that made the link once the service answers, instead of printing a pairing", () => {
    const r = rig("Linux");
    const run = install(r, ["--join", LINK]);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const state = join(r.home, ".local", "state", "doriface-host");
    expectJoinedFromFile(run.calls, `doriface-host mesh join --wait-host 60 --yes --state-dir ${state} --from-file `);
    expect(run.calls.some((call) => call.startsWith("doriface-host pair"))).toBe(false);
  });

  test("--no-service --join hands mesh join the link in a file too, never on its command line (#1201)", () => {
    const r = rig("Linux");
    const run = install(r, ["--no-service", "--join", LINK]);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const state = join(r.home, ".local", "state", "doriface-host");
    const hc = join(r.home, ".local", "bin", "hc");
    expectJoinedFromFile(run.calls, `doriface-host mesh join --yes --hc ${hc} --state-dir ${state} --from-file `);
  });

  test("DORIFACE_JOIN joins like --join, so the link can stay off the installer's own command line too (#1201)", () => {
    const r = rig("Linux");
    const run = install(r, [], [], { DORIFACE_JOIN: LINK });
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const state = join(r.home, ".local", "state", "doriface-host");
    expectJoinedFromFile(run.calls, `doriface-host mesh join --wait-host 60 --yes --state-dir ${state} --from-file `);
  });

  test("the service and the pairing use one state dir, the one this shell names, even with XDG_STATE_HOME set", () => {
    const r = rig("Linux");
    const state = join(r.root, "xdg-state");
    const run = install(r, [], [], { XDG_STATE_HOME: state });
    expect(run.code).toBe(0);
    const dir = join(state, "doriface-host");
    const unit = readFileSync(join(r.home, ".config", "systemd", "user", "doriface-host.service"), "utf8");
    expect(unit).toContain(`--state-dir "${dir}"`);
    expect(run.calls.at(-1)).toBe(`doriface-host pair --wait-host 60 --state-dir ${dir}`);
  });

  test("a published install.sh installs its own release by default, and the repository copy the latest", () => {
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toContain('release="__DORIFACE_RELEASE__"');
    const r = rig("Linux");
    const stamped = join(r.root, "install-v9.9.9.sh");
    // Stamped exactly as the release workflow stamps it: its own sed line, run over the whole script.
    const workflow = readFileSync(
      join(import.meta.dir, "..", "..", "..", ".github", "workflows", "release.yml"),
      "utf8",
    );
    const sedLine = /sed "(s\/__DORIFACE_RELEASE__\/\$TAG\/)"/.exec(workflow)?.[1];
    expect(sedLine).toBeDefined();
    const sed = Bun.spawnSync(["sed", (sedLine ?? "").replace("$TAG", "v9.9.9"), SCRIPT], { stdout: "pipe" });
    writeFileSync(stamped, sed.stdout);
    // No network: a curl stub records the URL the stamped script asks for, then fails the download.
    stub(r.stubs, "curl", `for a in "$@"; do case "$a" in http*) echo "curl $a" >> "${r.log}";; esac; done; exit 22`);
    Bun.spawnSync(["/bin/sh", stamped, "--no-service", "--no-pair"], {
      env: { HOME: r.home, PATH: [r.stubs, "/usr/bin", "/bin"].join(":"), TMPDIR: r.root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const asked = readFileSync(r.log, "utf8");
    expect(asked).toContain(
      "curl https://github.com/sisyphuslabs/doriterm/releases/download/v9.9.9/doriface-host-linux-x64",
    );
    expect(asked).not.toContain("/latest/");

    // The repository copy, never stamped, asks for the latest release.
    writeFileSync(r.log, "");
    Bun.spawnSync(["/bin/sh", SCRIPT, "--no-service", "--no-pair"], {
      env: { HOME: r.home, PATH: [r.stubs, "/usr/bin", "/bin"].join(":"), TMPDIR: r.root },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(readFileSync(r.log, "utf8")).toContain(
      "curl https://github.com/sisyphuslabs/doriterm/releases/latest/download/doriface-host-linux-x64",
    );
  });

  test("a path with a percent sign reaches systemd as itself, not as a specifier", () => {
    const r = rig("Linux");
    const bin = join(r.root, "100%bin");
    const run = install(r, ["--no-pair", "--bin-dir", bin]);
    expect(run.code).toBe(0);
    const unit = readFileSync(join(r.home, ".config", "systemd", "user", "doriface-host.service"), "utf8");
    expect(unit).toContain(`ExecStart="${join(r.root, "100%%bin", "doriface-host")}"`);
    expect(unit).not.toMatch(/100%bin/);
  });

  test("a path with a dollar sign, a quote and a backslash reaches systemd as itself (#834)", () => {
    const r = rig("Linux");
    const bin = join(r.root, 'a$HOME"q\\b');
    const run = install(r, ["--no-pair", "--bin-dir", bin]);
    expect(run.code).toBe(0);
    const unit = readFileSync(join(r.home, ".config", "systemd", "user", "doriface-host.service"), "utf8");
    // ExecStart expands $VAR, so the $ is doubled there; Environment= gives $ no meaning, so it stays single.
    expect(unit).toContain(`ExecStart="${join(r.root, 'a$$HOME\\"q\\\\b', "doriface-host")}"`);
    expect(unit).toContain(`Environment="PATH=${r.root}/a$HOME\\"q\\\\b:`);
  });

  test("a relative bin dir and state dir are written into the unit as absolute paths (#834)", () => {
    const r = rig("Linux");
    const here = realpathSync(r.root);
    const run = install(r, ["--no-pair", "--bin-dir", "rel-bin"], [], { DORIFACE_HOST_STATE_DIR: "rel-state" }, r.root);
    expect(run.code).toBe(0);
    const unit = readFileSync(join(r.home, ".config", "systemd", "user", "doriface-host.service"), "utf8");
    expect(unit).toContain(`ExecStart="${join(here, "rel-bin", "doriface-host")}"`);
    expect(unit).toContain(`--state-dir "${join(here, "rel-state")}"`);
  });

  test("keeps an hc already on PATH and runs the service with it", () => {
    const r = rig("Linux", "aarch64");
    const tools = join(r.root, "tools");
    mkdirSync(tools);
    stub(tools, "hc", "echo 0.1.17");
    const run = install(r, ["--no-pair"], [tools]);
    expect(run.code).toBe(0);
    expect(run.calls).not.toContain("doriface-host --install-hc");
    expect(run.calls.some((call) => call.startsWith("doriface-host pair"))).toBe(false);
    const unit = readFileSync(join(r.home, ".config", "systemd", "user", "doriface-host.service"), "utf8");
    expect(unit).toContain(`--hc "${join(tools, "hc")}"`);
    expect(run.out).toContain("using herdr-core at");
  });

  test("turns lingering on for a user who does not linger, so the service starts at boot without a login", () => {
    const r = rig("Linux");
    lingering(r.stubs, r.log, "no", "granted");
    // USER names someone else here: the installer must name the user the system reports.
    const run = install(r, ["--no-pair"], [], { USER: "someone-else" });
    expect(run.code).toBe(0);
    expect(enabledLinger(run.calls)).toEqual([`loginctl --no-ask-password enable-linger ${USER}`]);
    expect(run.out).toContain("it starts at boot");
    expect(run.out).not.toContain("sudo");
  });

  test("where only an admin may turn lingering on, installs anyway and names the one command to run", () => {
    const r = rig("Linux");
    lingering(r.stubs, r.log, "no", "refused");
    const run = install(r, ["--no-pair"]);
    expect(run.code).toBe(0);
    expect(run.calls).toContain("systemctl --user restart doriface-host.service");
    expect(run.out).toContain(`sudo loginctl enable-linger ${USER}`);
    expect(run.out).not.toContain("it starts at boot");
  });

  test("leaves a user who lingers already alone", () => {
    const r = rig("Linux");
    const run = install(r, ["--no-pair"]);
    expect(enabledLinger(run.calls)).toEqual([]);
    expect(run.out).not.toContain("linger");
  });

  test("a download that does not match SHA256SUMS.txt installs nothing and starts nothing", () => {
    const r = rig("Linux");
    writeFileSync(join(r.release, "doriface-host-linux-x64"), "#!/bin/sh\necho tampered\n");
    const run = install(r);
    expect(run.code).toBe(1);
    expect(run.err).toContain("does not match SHA256SUMS.txt");
    expect(existsSync(join(r.home, ".local", "bin", "doriface-host"))).toBe(false);
    expect(run.calls).toEqual(["systemctl --user show-environment"]);
  });

  test("without a systemd user manager it refuses before downloading, and --no-service installs only", () => {
    const r = rig("Linux");
    stub(r.stubs, "systemctl", `echo "systemctl $*" >> "${r.log}"; exit 1`);
    const refused = install(r);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--no-service");
    expect(existsSync(join(r.home, ".local", "bin", "doriface-host"))).toBe(false);

    const plain = install(r, ["--no-service"]);
    expect(plain.code).toBe(0);
    expect(existsSync(join(r.home, ".local", "bin", "doriface-host"))).toBe(true);
    expect(plain.out).toContain("start the host with:");
    expect(plain.calls.filter((call) => call.includes("daemon-reload"))).toEqual([]);
  });

  test("an upgrade keeps the state dir the installed service names, so the host keeps its identity (#1966)", () => {
    const r = rig("Linux");
    // Every character the unit escapes, so the installer reads back exactly the path it wrote.
    const custom = join(r.root, 'mesh 100% $HOME "q\\b');
    mkdirSync(custom);
    writeFileSync(join(custom, "identity"), "host A");
    expect(install(r, ["--no-pair"], [], { DORIFACE_HOST_STATE_DIR: custom }).code).toBe(0);
    const unitFile = join(r.home, ".config", "systemd", "user", "doriface-host.service");
    const before = readFileSync(unitFile, "utf8");

    const run = install(r, ["--version", "v0.1.16", "--no-pair"]);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    expect(readFileSync(unitFile, "utf8")).toBe(before);
    expect(readFileSync(join(custom, "identity"), "utf8")).toBe("host A");
    expect(run.calls.at(-1)).toBe("systemctl --user restart doriface-host.service");

    // Asked for by name, another state dir still wins.
    const other = join(r.root, "other");
    expect(install(r, ["--no-pair", "--state-dir", other]).code).toBe(0);
    expect(readFileSync(unitFile, "utf8")).toContain(`--state-dir "${other}"`);
  });

  test("--uninstall stops the service and removes it and the binary", () => {
    const r = rig("Linux");
    expect(install(r, ["--no-pair"]).code).toBe(0);
    writeFileSync(r.log, "");
    const run = install(r, ["--uninstall"]);
    expect(run.code).toBe(0);
    expect(run.calls).toContain("systemctl --user disable --now doriface-host.service");
    expect(existsSync(join(r.home, ".config", "systemd", "user", "doriface-host.service"))).toBe(false);
    expect(existsSync(join(r.home, ".local", "bin", "doriface-host"))).toBe(false);
  });
});

describe("install.sh on macOS", () => {
  test("running it again over a loaded agent waits for the old one to go before it registers the new one", () => {
    const r = rig("Darwin", "arm64");
    const state = join(r.root, "agent");
    // launchd unloads asynchronously: after bootout, print still finds the job twice, and bootstrap fails with 5 meanwhile.
    writeFileSync(state, "loaded");
    stub(
      r.stubs,
      "launchctl",
      [
        `echo "launchctl $*" >> "${r.log}"`,
        `s=$(cat "${state}")`,
        `case "$1" in`,
        `  bootout) echo 2 > "${state}" ;;`,
        `  print) case "$s" in gone) exit 113 ;; loaded) exit 0 ;; 0) echo gone > "${state}"; exit 113 ;; *) echo $((s - 1)) > "${state}"; exit 0 ;; esac ;;`,
        `  bootstrap) [ "$s" = gone ] || { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }; echo loaded > "${state}" ;;`,
        `esac`,
      ].join("\n"),
    );
    const run = install(r, ["--no-pair"]);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    expect(readFileSync(state, "utf8").trim()).toBe("loaded");
  });

  // About 200 stub processes (101 `launchctl print`, 100 `sleep`): nothing is slept, but on a busy host the spawns alone
  // can pass bun's default 5 s, so the test gets a bound sized to them (#2006).
  test("an old agent that never unloads stops the install after 10 s and never bootstraps the new one (#834)", () => {
    const r = rig("Darwin", "arm64");
    stub(r.stubs, "launchctl", `echo "launchctl $*" >> "${r.log}"; exit 0`);
    // The wait's own clock: each 0.1 s step is recorded instead of slept.
    stub(r.stubs, "sleep", `echo "sleep $*" >> "${r.log}"`);
    const run = install(r, ["--no-pair"]);
    expect(run.code).toBe(1);
    expect(run.calls.filter((call) => call.startsWith("launchctl print"))).toHaveLength(101);
    expect(run.calls.filter((call) => call === "sleep 0.1")).toHaveLength(100);
    expect(run.calls.some((call) => call.startsWith("launchctl bootstrap"))).toBe(false);
  }, 30_000);

  test("an upgrade keeps the agent's state dir and identity, and leaves the agent loaded (#1966)", () => {
    const r = rig("Darwin", "arm64");
    const custom = join(r.root, "mesh & <state>");
    mkdirSync(custom);
    writeFileSync(join(custom, "identity"), "host A");
    expect(install(r, ["--no-pair"], [], { DORIFACE_HOST_STATE_DIR: custom }).code).toBe(0);
    const plistFile = join(r.home, "Library", "LaunchAgents", "dev.omo.doriface-host.plist");
    const before = readFileSync(plistFile, "utf8");
    expect(before).toContain(`<string>${r.root}/mesh &amp; &lt;state&gt;</string>`);

    // The upgrade, as #1966 ran it; launchd refuses the first bootstrap after the old agent leaves `print`.
    const agent = launchd(r.stubs, r.log, 1);
    writeFileSync(agent, "loaded");
    stub(r.stubs, "sleep", `echo "sleep $*" >> "${r.log}"`);
    const run = install(r, ["--version", "v0.1.16", "--no-pair"]);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    expect(readFileSync(plistFile, "utf8")).toBe(before);
    expect(readFileSync(join(custom, "identity"), "utf8")).toBe("host A");
    expect(readFileSync(agent, "utf8").trim()).toBe("loaded");
  });

  // As many stub processes as the never-unloads test (100 bootstrap attempts through the launchd stub, each running its
  // own `cat`, and 99 `sleep`), so the same bound (#2006).
  test("a bootstrap launchd keeps refusing fails the install loudly instead of leaving the agent quietly unloaded", () => {
    const r = rig("Darwin", "arm64");
    launchd(r.stubs, r.log, 1000);
    stub(r.stubs, "sleep", `echo "sleep $*" >> "${r.log}"`);
    const run = install(r, ["--no-pair"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("Bootstrap failed: 5: Input/output error");
    expect(run.err).toContain("launchctl bootstrap gui/");
  }, 30_000);

  test("registers a LaunchAgent that keeps the host running, then pairs", () => {
    const r = rig("Darwin", "arm64");
    const run = install(r);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const uid = Bun.spawnSync(["id", "-u"]).stdout.toString().trim();
    expect(run.calls).toEqual([
      "doriface-host --install-hc",
      "doriface-host --help",
      `launchctl bootout gui/${uid}/dev.omo.doriface-host`,
      `launchctl print gui/${uid}/dev.omo.doriface-host`,
      `launchctl bootstrap gui/${uid} ${join(r.home, "Library", "LaunchAgents", "dev.omo.doriface-host.plist")}`,
      `launchctl print gui/${uid}/dev.omo.doriface-host`,
      `doriface-host pair --wait-host 60 --state-dir ${join(r.home, ".local", "state", "doriface-host")}`,
    ]);
    const plist = readFileSync(join(r.home, "Library", "LaunchAgents", "dev.omo.doriface-host.plist"), "utf8");
    expect(plist).toContain(`<string>${join(r.home, ".local", "bin", "doriface-host")}</string>`);
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>ProcessType</key><string>Interactive</string>");
    expect(plist).not.toMatch(/LowPriority|<key>Nice<\/key>|Background/);
  });
});

describe("install.sh elsewhere", () => {
  test("names the desktop app on Windows-like systems and refuses an unknown CPU", () => {
    expect(install(rig("MINGW64_NT" as "Linux")).err).toContain("install the desktop app");
    expect(install(rig("Linux", "riscv64")).err).toContain("no doriface-host build for CPU riscv64");
  });
});
