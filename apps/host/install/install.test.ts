import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  removeRigs,
  SCRIPT,
  USER,
  stub,
  lingering,
  enabledLinger,
  rig,
  install,
  LINK,
  expectJoinedFromFile,
} from "./install-rig.ts";

// Each case runs the real installer, about 50 stub processes (counted with strace: the lingering cases spawn 50 and 46).
// A loaded macOS runner spent about 100 ms per spawn, so one case took 5.1 s and passed bun's 5 s default by nothing
// it did wrong (#2487). 15 s is three times that measured worst case; the two ~340-spawn cases keep their 30 s (#2006).
setDefaultTimeout(15_000);
afterEach(removeRigs);

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
    const run = install(r, ["--no-pair"]);
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

describe("install.sh elsewhere", () => {
  test("names the desktop app on Windows-like systems and refuses an unknown CPU", () => {
    expect(install(rig("MINGW64_NT" as "Linux")).err).toContain("install the desktop app");
    expect(install(rig("Linux", "riscv64")).err).toContain("no doriface-host build for CPU riscv64");
  });
});
