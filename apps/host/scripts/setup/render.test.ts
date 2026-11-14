import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LABEL,
  bunMeetsFloor,
  desktopStateDir,
  failureOf,
  hcVersionOf,
  hostFailure,
  installedHcPath,
  lastRelayState,
  readExistingService,
  readMeshPair,
  readMeshStatus,
  renderPlist,
  renderUnit,
  setupOs,
  setupPaths,
  withCoreLines,
} from "./render.ts";

const tools = { bun: "/home/u/.bun/bin/bun", hc: "/home/u/.local/bin/hc", shell: "/bin/bash" };
const linux = setupPaths("linux", "/home/u", {}, tools);
const mac = setupPaths("mac", "/Users/u", {}, { ...tools, bun: "/Users/u/.bun/bin/bun", hc: "/Users/u/.local/bin/hc" });

describe("setup paths", () => {
  test("a fresh install never takes the desktop app's state dir", () => {
    expect(linux.stateDir).toBe("/home/u/.local/state/doriface-host-mesh");
    expect(linux.stateDir).not.toBe(desktopStateDir("/home/u", {}));
    expect(mac.stateDir).toBe("/Users/u/.local/state/doriface-host-mesh");
    expect(setupPaths("linux", "/home/u", { XDG_STATE_HOME: "/x/state" }, tools).stateDir).toBe(
      "/x/state/doriface-host-mesh",
    );
  });

  test("the service file and label follow the OS", () => {
    expect(linux.serviceFile).toBe("/home/u/.config/systemd/user/doriface-host.service");
    expect(mac.label).toBe(DEFAULT_LABEL);
    expect(mac.serviceFile).toBe(`/Users/u/Library/LaunchAgents/${DEFAULT_LABEL}.plist`);
  });

  test("a path either format would have to quote is refused", () => {
    for (const src of ["/home/u/my src", "/home/u/a&b", "/home/u/%h", "/home/u/$x", '/home/u/"q"']) {
      expect(() => setupPaths("linux", "/home/u", {}, tools, { src })).toThrow(/special character/);
    }
    expect(() => setupPaths("linux", "/home/u", {}, tools, { label: "a/b" })).toThrow(/label/);
  });

  test("only Linux and macOS are set up here", () => {
    expect(setupOs("linux")).toBe("linux");
    expect(setupOs("darwin")).toBe("mac");
    expect(() => setupOs("win32")).toThrow(/desktop app/);
  });
});

describe("service files", () => {
  test("the unit runs the checkout with the state dir, restarts, and logs to a file", () => {
    const unit = renderUnit(linux);
    expect(unit).toContain(
      "ExecStart=/home/u/.bun/bin/bun /home/u/.local/share/doriface-host/src/apps/host/src/cli.ts --hc /home/u/.local/bin/hc --state-dir /home/u/.local/state/doriface-host-mesh\n",
    );
    expect(unit).toContain("Restart=always\n");
    expect(unit).toContain(`StandardOutput=append:${linux.logFile}\n`);
    expect(unit).toContain("WantedBy=default.target\n");
    expect(renderUnit({ ...linux, listen: "127.0.0.1:0" })).toContain("--listen 127.0.0.1:0\n");
    expect(renderUnit({ ...linux, session: "work" })).toContain(
      "--state-dir /home/u/.local/state/doriface-host-mesh --session work\n",
    );
  });

  test("the plist carries no comment and no entity reference", () => {
    const plist = renderPlist(mac);
    expect(plist).not.toContain("<!--");
    expect(plist).not.toMatch(/&[#a-z]/);
    expect(plist).toContain(`<key>Label</key><string>${DEFAULT_LABEL}</string>`);
    expect(plist).toContain("<key>KeepAlive</key><true/>");
  });

  test("rendering is stable, so a re-run compares equal and restarts nothing", () => {
    expect(renderUnit(linux)).toBe(renderUnit(setupPaths("linux", "/home/u", {}, tools)));
  });
});

describe("an existing service", () => {
  const src = "/home/u/.local/share/doriface-host/src";

  test("this skill's own unit is adopted with its state dir", () => {
    expect(readExistingService(renderUnit(linux), src, "/home/u")).toEqual({
      kind: "checkout",
      stateDir: "/home/u/.local/state/doriface-host-mesh",
      listen: undefined,
      session: undefined,
      logFile: linux.logFile,
      bun: "/home/u/.bun/bin/bun",
      shell: "/bin/bash",
    });
    expect(readExistingService(renderPlist(mac), "/Users/u/.local/share/doriface-host/src", "/Users/u")).toEqual({
      kind: "checkout",
      stateDir: "/Users/u/.local/state/doriface-host-mesh",
      listen: undefined,
      session: undefined,
      logFile: mac.logFile,
      bun: "/Users/u/.bun/bin/bun",
      shell: "/bin/bash",
    });
  });

  test("the mesh kit's %h unit is adopted with its state dir", () => {
    const kit =
      "[Service]\nExecStart=%h/.bun/bin/bun %h/.local/share/doriface-host/src/apps/host/src/cli.ts --hc %h/.local/bin/hc --state-dir %h/.local/state/doriface-host\n";
    expect(readExistingService(kit, src, "/home/u")).toEqual({
      kind: "checkout",
      stateDir: "/home/u/.local/state/doriface-host",
      listen: undefined,
      session: undefined,
      logFile: undefined,
      bun: "/home/u/.bun/bin/bun",
      shell: undefined,
    });
  });

  test("the mesh kit's plist is adopted with its state dir and its log", () => {
    const kit = renderPlist({ ...mac, logFile: "/Users/u/Library/Logs/doriface-host.log" });
    expect(readExistingService(kit, "/Users/u/.local/share/doriface-host/src", "/Users/u")).toEqual({
      kind: "checkout",
      stateDir: "/Users/u/.local/state/doriface-host-mesh",
      listen: undefined,
      session: undefined,
      logFile: "/Users/u/Library/Logs/doriface-host.log",
      bun: "/Users/u/.bun/bin/bun",
      shell: "/bin/bash",
    });
  });

  test("install.sh's compiled binary is another install, never overwritten", () => {
    const installer =
      '[Service]\nExecStart="/home/u/.local/bin/doriface-host" --hc "/usr/bin/hc" --state-dir "/home/u/.local/state/doriface-host"\n';
    expect(readExistingService(installer, src, "/home/u").kind).toBe("other");
  });
});

describe("the host's own output", () => {
  test("the relay state is the latest relay line", () => {
    const log = [
      "relay: connecting to wss://relay-doriface.omo.dev",
      "relay: connected to wss://relay-doriface.omo.dev",
      "relay: uplink closed (1006); reconnecting in 2 s",
    ].join("\n");
    expect(lastRelayState(log)).toBe("reconnecting");
    expect(lastRelayState(`${log}\nrelay: connected to wss://relay-doriface.omo.dev`)).toBe("connected");
    expect(lastRelayState("listening on 127.0.0.1:7766")).toBeUndefined();
    expect(lastRelayState("relay: uplink closed (1006); reconnecting in 180 ms")).toBe("reconnecting");
    expect(lastRelayState("relay: uplink closed (1006); reconnecting now")).toBe("reconnecting");
  });

  test("mesh pair's link is found and the code is not carried", () => {
    const output = [
      "On the machine that joins, run: doriface-host mesh join '<this link>' (or the code with --fingerprint).",
      "",
      "doriface://pair#h=abc&k=def",
      "",
      "code        ABCD-EFGH",
      "fingerprint 1A2B 3C4D",
      "host        abc",
      "expires     2026-11-06T09:00:00.000Z",
    ].join("\n");
    const invite = readMeshPair(output);
    expect(invite).toEqual({
      link: "doriface://pair#h=abc&k=def",
      fingerprint: "1A2B 3C4D",
      expires: "2026-11-06T09:00:00.000Z",
    });
    expect(JSON.stringify(invite)).not.toContain("ABCD-EFGH");
    expect(() => readMeshPair("no link here")).toThrow(/no join link/);
  });

  test("mesh status names each member and its line", () => {
    const json = JSON.stringify({
      meshId: "m1",
      sync: "ok",
      members: [
        { hostId: "a", name: "ny", line: "self" },
        { hostId: "b", name: null, line: "connected" },
      ],
    });
    expect(readMeshStatus(json)).toEqual({
      meshId: "m1",
      sync: "ok",
      members: [
        { name: "ny", hostId: "a", line: "self" },
        { name: "b", hostId: "b", line: "connected" },
      ],
    });
    expect(() => readMeshStatus("{}")).toThrow(/lacks/);
  });

  test("a line's state comes from the core's machine list, which mesh status lags behind", () => {
    const status = {
      meshId: "m1",
      sync: "ok",
      members: [
        { name: "a", hostId: "aaaa", line: "self" },
        { name: "b", hostId: "bbbb", line: "connecting" },
        { name: "c", hostId: "cccc", line: "unreachable" },
      ],
    };
    const machines = JSON.stringify({
      machines: [
        { name: "b-4dkk", state: "connected", target: "'/s/doriface-host' connect --mesh --state-dir '/s' bbbb" },
        { name: "a", state: "unreachable", target: "'/s/doriface-host' connect --mesh --state-dir '/s' aaaa" },
        { name: "ssh-box", state: "connected", target: "ssh box hc connect" },
      ],
    });
    expect(withCoreLines(status, machines).members.map((member) => member.line)).toEqual([
      "self",
      "connected",
      "unreachable",
    ]);
    expect(withCoreLines(status, undefined)).toEqual(status);
  });

  test("the installer's own path is used, since it adds no hc link when an older hc is on PATH", () => {
    const output =
      "herdr-core 0.1.18 installed at /home/u/.local/bin/herdr-core\nAdd /home/u/.local/bin to your PATH, or pass --hc /home/u/.local/bin/herdr-core.\n";
    expect(installedHcPath(output)).toBe("/home/u/.local/bin/herdr-core");
    expect(() => installedHcPath("doriface-host --install-hc: no network")).toThrow(/did not say/);
  });

  test("a failed host command reports its cause line, not the usage text after it", () => {
    const stderr =
      "doriface-host: mesh join needs a mesh pairing link or code\n\nusage: doriface-host mesh pair [--auto]\n       doriface-host mesh join <link>\n  --state-dir <dir>  the host's state\n";
    expect(hostFailure(stderr)).toBe("doriface-host: mesh join needs a mesh pairing link or code");
    expect(hostFailure("error: Module not found\n")).toBe("error: Module not found");
    expect(hostFailure("")).toBe("(no output)");
  });

  test("a failed git or bun step reports stderr's cause, not stdout's banner", () => {
    expect(failureOf("error: lockfile had changes, but lockfile is frozen\n", "bun install v1.4.4 (38afee6c8)\n")).toBe(
      "error: lockfile had changes, but lockfile is frozen",
    );
    expect(failureOf("doriface-host: no running host\n\nusage: doriface-host mesh\n", "")).toBe(
      "doriface-host: no running host",
    );
    expect(failureOf("", "only stdout\n")).toBe("only stdout");
  });

  test("versions", () => {
    expect(hcVersionOf("hc 0.1.17\n")).toBe("0.1.17");
    expect(bunMeetsFloor("1.4.4")).toBe(true);
    expect(bunMeetsFloor("1.10.0")).toBe(true);
    expect(bunMeetsFloor("1.4.3")).toBe(false);
  });
});
