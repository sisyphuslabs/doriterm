import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderService, type SetupOs, setupPaths } from "./render.ts";
import { DEFAULT_FLAG, resolvePaths, type SetupContext, setupOptions } from "./setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const context = (os: SetupOs, home: string, options: SetupContext["options"]): SetupContext => ({
  os,
  home,
  env: {},
  report: () => {},
  options,
  run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
});

test("--listen default and --session default clear what the installed service ran with (#821)", () => {
  for (const os of ["linux", "mac"] as const) {
    const home = mkdtempSync(join(tmpdir(), "dt-setup-defaults-"));
    roots.push(home);
    const tools = { bun: process.execPath, hc: join(home, "hc"), shell: "/bin/sh" };
    const installed = setupPaths(os, home, {}, tools, {
      stateDir: join(home, "state"),
      listen: "127.0.0.1:0",
      session: "work",
    });
    mkdirSync(dirname(installed.serviceFile), { recursive: true });
    writeFileSync(installed.serviceFile, renderService(installed));
    const options = { src: installed.src, listen: DEFAULT_FLAG, session: DEFAULT_FLAG };
    const after = resolvePaths(context(os, home, options), tools.hc);
    expect([after.listen, after.session, after.stateDir]).toEqual([undefined, undefined, installed.stateDir]);
    expect(renderService(after)).toBe(renderService({ ...installed, listen: undefined, session: undefined }));
  }
});

test("a re-run with only --profile keeps the installed profile service's state dir, listen and session (#2860 review M1)", () => {
  for (const os of ["linux", "mac"] as const) {
    const home = mkdtempSync(join(tmpdir(), "dt-setup-defaults-"));
    roots.push(home);
    const tools = { bun: process.execPath, hc: join(home, "hc"), shell: "/bin/sh" };
    const options = setupOptions({}, "work", os, join(home, ".local", "state"));
    const installed = setupPaths(os, home, {}, tools, {
      label: options.label,
      stateDir: join(home, "custom"),
      listen: "127.0.0.1:9000",
      session: "mine",
    });
    mkdirSync(dirname(installed.serviceFile), { recursive: true });
    writeFileSync(installed.serviceFile, renderService(installed));
    const after = resolvePaths(context(os, home, { ...options, src: installed.src }), tools.hc);
    expect([after.stateDir, after.listen, after.session]).toEqual([join(home, "custom"), "127.0.0.1:9000", "mine"]);
  }
});

test("under a profile, a first install takes the profile's own defaults, and default means the profile's (#2860 review L3)", () => {
  const home = mkdtempSync(join(tmpdir(), "dt-setup-defaults-"));
  roots.push(home);
  const root = join(home, ".local", "state");
  const first = resolvePaths(context("linux", home, setupOptions({}, "work", "linux", root)), join(home, "hc"));
  expect([first.stateDir, first.listen, first.session]).toEqual([
    join(root, "doriface-host-profiles", "work"),
    "127.0.0.1:0",
    "doriterm-work",
  ]);
  const reset = resolvePaths(
    context("linux", home, setupOptions({ listen: DEFAULT_FLAG, session: DEFAULT_FLAG }, "work", "linux", root)),
    join(home, "hc"),
  );
  expect([reset.listen, reset.session]).toEqual(["127.0.0.1:0", "doriterm-work"]);
});

test("on a machine with no service yet, default is the host's default, never a literal value (#821)", () => {
  const home = mkdtempSync(join(tmpdir(), "dt-setup-defaults-"));
  roots.push(home);
  const after = resolvePaths(context("linux", home, { listen: DEFAULT_FLAG, session: DEFAULT_FLAG }), join(home, "hc"));
  expect([after.listen, after.session]).toEqual([undefined, undefined]);
});
