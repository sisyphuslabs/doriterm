import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupPaths } from "../../scripts/setup/render.ts";
import { defaultStateDir } from "./files.ts";
import { hostProfile, ProfileRefused, profileSetupOptions, serveDefaults } from "./profile.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DORITERM_PROFILE (#2858)", () => {
  test("unset or empty names no profile; a well-formed name is kept as given", () => {
    expect(hostProfile({})).toBeUndefined();
    expect(hostProfile({ DORITERM_PROFILE: "" })).toBeUndefined();
    expect(hostProfile({ DORITERM_PROFILE: "work" })).toBe("work");
    expect(hostProfile({ DORITERM_PROFILE: "a" })).toBe("a");
    expect(hostProfile({ DORITERM_PROFILE: `x${"-a".repeat(15)}1` })).toHaveLength(32);
  });

  test.each(["Work", "-work", "work-", "a/b", "..", "../x", "a b", "a_b", `a${"b".repeat(32)}`])(
    "%j is refused, never cleaned into another name",
    (name) => {
      expect(() => hostProfile({ DORITERM_PROFILE: name })).toThrow(ProfileRefused);
    },
  );

  test("the state dir: an explicit dir wins, then the profile's own dir, then the default host's", () => {
    const xdg = { XDG_STATE_HOME: "/s" };
    expect(defaultStateDir(xdg)).toBe("/s/doriface-host");
    expect(defaultStateDir({ ...xdg, DORITERM_PROFILE: "work" })).toBe("/s/doriface-host-profiles/work");
    expect(defaultStateDir({ ...xdg, DORITERM_PROFILE: "work", DORIFACE_HOST_STATE_DIR: "/e" })).toBe("/e");
    expect(() => defaultStateDir({ ...xdg, DORITERM_PROFILE: "../x" })).toThrow(ProfileRefused);
  });

  test("serve: a profile takes its own hc session and any free port, the default host keeps 7766, flags win", () => {
    expect(serveDefaults(undefined, {})).toEqual({ listen: "127.0.0.1:7766", session: undefined });
    expect(serveDefaults("work", {})).toEqual({ listen: "127.0.0.1:0", session: "doriterm-work" });
    expect(serveDefaults("work", { listen: "127.0.0.1:9000", session: "mine" })).toEqual({
      listen: "127.0.0.1:9000",
      session: "mine",
    });
  });

  test.each(["linux", "mac"] as const)(
    "setup on %s: a profile's service has its own label, state dir and session",
    (os) => {
      const options = profileSetupOptions("work", os, "/home/u/.local/state");
      const paths = setupPaths(os, "/home/u", {}, { bun: "/b/bun", hc: "/b/hc", shell: "/bin/sh" }, options);
      expect(paths.label).toBe(os === "mac" ? "com.sisyphuslabs.doriface-host.work" : "doriface-host-work");
      expect(paths.stateDir).toBe("/home/u/.local/state/doriface-host-profiles/work");
      expect(paths.session).toBe("doriterm-work");
      expect(paths.listen).toBe("127.0.0.1:0");
    },
  );

  test("two profiles and the default host on one computer hold three separate identities", async () => {
    const root = mkdtempSync(join(tmpdir(), "dt-profile-"));
    roots.push(root);
    const fingerprint = async (profile: string | undefined): Promise<string> => {
      const env = { PATH: process.env["PATH"], HOME: root, XDG_STATE_HOME: join(root, "state") };
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "cli.ts"), "fingerprint"], {
        env: profile === undefined ? env : { ...env, DORITERM_PROFILE: profile },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(code).toBe(0);
      return out.trim();
    };
    const prints = [await fingerprint(undefined), await fingerprint("work"), await fingerprint("home")];
    expect(new Set(prints).size).toBe(3);
    expect(await fingerprint("work")).toBe(prints[1] ?? "");
    for (const dir of ["doriface-host", "doriface-host-profiles/work", "doriface-host-profiles/home"]) {
      expect(existsSync(join(root, "state", dir, "host-keys.json"))).toBe(true);
    }
  });

  test("a malformed profile stops the command before it writes any state", async () => {
    const root = mkdtempSync(join(tmpdir(), "dt-profile-"));
    roots.push(root);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "cli.ts"), "fingerprint"], {
      env: { PATH: process.env["PATH"], HOME: root, XDG_STATE_HOME: join(root, "state"), DORITERM_PROFILE: "../x" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(2);
    expect(err).toContain("DORITERM_PROFILE");
    expect(existsSync(join(root, "state"))).toBe(false);
  });
});
