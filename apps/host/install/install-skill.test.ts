import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeRigs, rig, install } from "./install-rig.ts";

// Each case runs the real installer, about 50 stub processes (counted with strace: the lingering cases spawn 50 and 46).
// A loaded macOS runner spent about 100 ms per spawn, so one case took 5.1 s and passed bun's 5 s default by nothing
// it did wrong (#2487). 15 s is three times that measured worst case; the two ~340-spawn cases keep their 30 s (#2006).
setDefaultTimeout(15_000);
afterEach(removeRigs);

describe("install.sh and the agent skill (#2653)", () => {
  test("a host that offers skill install installs the agent skill with the installer's state dir, before the service", () => {
    const r = rig("Linux");
    writeFileSync(join(r.root, "help"), "doriface-host skill install [--dir <dir>]... | skill status [--json]\n");
    const run = install(r, ["--no-pair"]);
    expect(run.code).toBe(0);
    const state = join(r.home, ".local", "state", "doriface-host");
    expect(run.calls.slice(1, 4)).toEqual([
      "doriface-host --install-hc",
      "doriface-host --help",
      `doriface-host skill install --state-dir ${state}`,
    ]);
    expect(run.calls).toContain("systemctl --user restart doriface-host.service");
  });

  test("an agent skill that cannot be installed is said, and the host is installed anyway", () => {
    const r = rig("Linux");
    writeFileSync(join(r.root, "help"), "doriface-host skill install\n");
    writeFileSync(join(r.root, "skill-exit"), "1");
    const run = install(r, ["--no-pair"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("the agent skill was not installed; install it later with:");
    expect(run.calls).toContain("systemctl --user restart doriface-host.service");
  });
});
