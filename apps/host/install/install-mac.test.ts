import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeRigs, stub, launchd, rig, install } from "./install-rig.ts";

setDefaultTimeout(15_000);
afterEach(removeRigs);

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
