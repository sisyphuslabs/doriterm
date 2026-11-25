import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findHc,
  hostChildEnv,
  hostCommand,
  saveHc,
  savedHc,
  usualHcDirs,
  type HostContext,
} from "../src/main/host-command.ts";

const context = (overrides: Partial<HostContext>): HostContext => ({
  packaged: false,
  resourcesPath: "/res",
  appPath: "/repo/apps/desktop",
  platform: "linux",
  home: "/home/u",
  env: {},
  ...overrides,
});

describe("doriface-host command", () => {
  test("a checkout runs the workspace host with bun", () => {
    expect(hostCommand(context({}))).toEqual({ file: "bun", args: [join("/repo/apps", "host", "src", "cli.ts")] });
  });

  test("an empty BUN_BIN counts as unset", () => {
    expect(hostCommand(context({ env: { BUN_BIN: "" } })).file).toBe("bun");
    expect(hostCommand(context({ env: { BUN_BIN: "/opt/bun" } })).file).toBe("/opt/bun");
  });

  test("a packaged app runs the bundled binary", () => {
    expect(hostCommand(context({ packaged: true }))).toEqual({ file: join("/res", "bin", "doriface-host"), args: [] });
    expect(hostCommand(context({ packaged: true, platform: "win32" })).file).toBe(
      join("/res", "bin", "doriface-host.exe"),
    );
  });

  test("DORIFACE_HOST_BIN overrides both", () => {
    expect(hostCommand(context({ packaged: true, env: { DORIFACE_HOST_BIN: "/opt/h" } }))).toEqual({
      file: "/opt/h",
      args: [],
    });
  });
});

describe("finding hc", () => {
  test("the usual directories follow the platform", () => {
    const unix = [join("/h", ".local", "bin"), join("/h", ".cargo", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
    expect(usualHcDirs(context({ home: "/h" }))).toEqual(unix);
    expect(usualHcDirs(context({ home: "/h", platform: "win32" }))).toEqual(unix.slice(0, 2));
  });

  test("an hc chosen in the app comes after HC_BIN and before PATH, and the choice survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "dh-chosen-"));
    try {
      const local = join(dir, "local");
      mkdirSync(local);
      writeFileSync(join(local, "hc"), "#!/bin/sh\n");
      chmodSync(join(local, "hc"), 0o755);
      const file = join(dir, "hc.json");
      expect(savedHc(file, () => {})).toBeUndefined();
      saveHc(file, "/chosen/hc");
      expect(savedHc(file, () => {})).toBe("/chosen/hc");
      const chosen = savedHc(file, () => {});
      expect(findHc(context({ env: { PATH: local } }), [], chosen)).toBe("/chosen/hc");
      expect(findHc(context({ env: { HC_BIN: "/pinned/hc", PATH: local } }), [], chosen)).toBe("/pinned/hc");
      expect(findHc(context({ env: { PATH: local } }), [], undefined)).toBe(join(local, "hc"));
      writeFileSync(file, JSON.stringify({ path: 7 }));
      expect(savedHc(file, () => {})).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("HC_BIN wins, then PATH, then the usual install directories", () => {
    const home = mkdtempSync(join(tmpdir(), "dd-hc-"));
    try {
      const local = join(home, ".local", "bin");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "hc"), "#!/bin/sh\n");
      chmodSync(join(local, "hc"), 0o755);
      const empty = join(home, "empty");
      expect(findHc(context({ home, env: { HC_BIN: "/pinned/hc", PATH: local } }), [])).toBe("/pinned/hc");
      expect(findHc(context({ home, env: { PATH: local } }), [])).toBe(join(local, "hc"));
      expect(findHc(context({ home, env: { PATH: "" } }), [local])).toBe(join(local, "hc"));
      expect(findHc(context({ home, env: { PATH: empty } }), [empty])).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the host child env (#2399)", () => {
  test("a production launch skips the resolution entirely: the env passes through untouched", () => {
    const env: Record<string, string | undefined> = { PATH: "/bin" };
    const ctx = context({ packaged: true, resourcesPath: "/res", env: {} });
    // Identity, not a copy: no override is active, so no new key is added and the object is the very one given.
    expect(hostChildEnv(ctx, env)).toBe(env);
    expect(env["DORIFACE_HOST_RESOLVED"]).toBeUndefined();
  });

  test("an e2e-overridden launch carries the host the app itself resolved", () => {
    const env: Record<string, string | undefined> = { PATH: "/bin", DORIFACE_HOST_BIN: "/run/host-wrapper.ts" };
    const ctx = context({ packaged: true, resourcesPath: "/res", env });
    const out = hostChildEnv(ctx, env);
    expect(out).not.toBe(env);
    expect(out["DORIFACE_HOST_RESOLVED"]).toBe(join("/res", "bin", "doriface-host"));
  });
});
